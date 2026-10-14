// Library screen: folder tree on the left, notes in the centre.
// Layouts: wide = side by side; tablet portrait = tree in a drawer; phone = two steps.
import { h, iconButton, clear } from '../dom.js';
import { icon } from '../icons.js';
import { t, formatDate, formatTime } from '../i18n.js';
import * as prefs from '../prefs.js';
import { store, sortNotes } from '../store.js';
import { openMenu } from '../ui/menu.js';
import { renderCover } from './cover.js';
import { attachGestures } from './gestures.js';
import * as act from './actions.js';
import { openSearch } from '../panels/search.js';
import { openImport } from '../panels/import.js';
import { exportNotes } from '../export/notes.js';

const QUICK_VIEWS = [
  { kind: 'all', icon: 'notes', label: () => t('views.all') },
  { kind: 'favorites', icon: 'star', label: () => t('views.favorites') },
  { kind: 'recent', icon: 'clock', label: () => t('views.recent') },
];

// Opens the Tailscale app on Android. A web app cannot switch a VPN itself; if Android
// refuses to open the app directly, Chrome shows its Play Store page with "Apri".
const TAILSCALE_INTENT = 'intent://#Intent;package=com.tailscale.ipn;end';
const IS_ANDROID = /Android/i.test(navigator.userAgent);

const mqWide = matchMedia('(min-width: 900px)');
const mqPhone = matchMedia('(max-width: 599px)');

export function createLibrary({ openNote, newNote, openTrash, openSettings, openCover }) {
  const st = {
    view: prefs.get('lastView') || { kind: 'all', id: null },
    selecting: false,
    selection: new Set(),
    anchor: null,
    step: 'notes',          // phone: 'folders' | 'notes'
    drawerOpen: false,
    dragging: null,         // { kind: 'note'|'folder', ids }
  };
  if (st.view.kind === 'folder' && st.view.id && !store.folders.has(st.view.id) && store.loaded) st.view = { kind: 'all', id: null };

  // ------------------------------------------------------------ skeleton
  const treeEl = h('nav.tree', { 'aria-label': t('views.folders') });
  const syncEl = h('button.sync', { type: 'button', onclick: () => onSyncTap() });
  const trashBtn = h('button.side-link', { type: 'button', onclick: () => openTrash() }, icon('trash'), h('span', {}, t('library.trash')), h('span.count'));
  const side = h('aside.lib-side', {},
    h('div.side-head', {},
      h('div.brand', {}, appMark(), h('span', {}, t('app.name'))),
      iconButton('folderPlus', t('library.newFolder'), () => createFolderIn(currentFolderId()))),
    treeEl,
    h('div.side-foot', {},
      trashBtn,
      h('button.side-link', { type: 'button', onclick: () => openImport({ folderId: currentFolderId(), onDone: () => store.load().catch(() => {}) }) }, icon('importFiles'), h('span', {}, t('import.open'))),
      h('button.side-link', { type: 'button', onclick: () => openSettings() }, icon('settings'), h('span', {}, t('library.settings'))),
      IS_ANDROID ? h('a.side-link', { href: TAILSCALE_INTENT, title: t('tailscale.hint') }, icon('network'), h('span', {}, t('tailscale.open'))) : null,
      syncEl));

  const titleEl = h('h1.main-title');
  const crumbEl = h('div.crumbs');
  const viewBtn = iconButton('grid', '', () => toggleView());
  const headActions = h('div.head-actions', {},
    iconButton('search', t('search.title'), () => openSearch({ folderId: currentFolderId(), openNote })),
    iconButton('select', t('library.select'), () => startSelecting()),
    viewBtn,
    iconButton('sort', t('library.sort'), (e) => sortMenu(e.currentTarget)));
  const head = h('header.main-head', {},
    iconButton('menu', t('library.showFolders'), () => openFolders(), { class: 'only-narrow' }),
    h('div.main-titles', {}, crumbEl, titleEl), headActions);
  const selBar = h('header.sel-bar', { hidden: true });
  const chipsEl = h('div.chips');
  const notesEl = h('div.notes', { role: 'list' });
  const emptyEl = h('p.empty', { hidden: true });
  const fab = h('button.fab', { type: 'button', 'aria-label': t('library.newNote'), title: t('library.newNote'), onclick: () => newNote(currentFolderId()) }, icon('plus'));
  const scroller = h('div.main-scroll', {}, chipsEl, notesEl, emptyEl);
  const main = h('main.lib-main', {}, head, selBar, scroller, fab);
  const scrim = h('div.scrim', { onclick: () => setDrawer(false) });
  const root = h('div.library', {}, side, main, scrim);

  // ------------------------------------------------------------ layout
  function applyLayout() {
    root.classList.toggle('wide', mqWide.matches);
    root.classList.toggle('drawer-mode', !mqWide.matches && !mqPhone.matches);
    root.classList.toggle('phone', mqPhone.matches);
    root.classList.toggle('step-folders', mqPhone.matches && st.step === 'folders');
    root.classList.toggle('drawer-open', !mqWide.matches && !mqPhone.matches && st.drawerOpen);
  }
  mqWide.addEventListener('change', applyLayout);
  mqPhone.addEventListener('change', applyLayout);

  function openFolders() {
    if (mqPhone.matches) { st.step = 'folders'; applyLayout(); } else setDrawer(true);
  }
  function setDrawer(open) { st.drawerOpen = open; applyLayout(); }

  // ------------------------------------------------------------ views
  const currentFolderId = () => (st.view.kind === 'folder' ? st.view.id ?? null : null);

  function setView(view) {
    st.view = view;
    prefs.set('lastView', view);
    st.step = 'notes';
    st.drawerOpen = false;
    stopSelecting();
    applyLayout();
    render();
    scroller.scrollTop = 0;
  }

  function viewTitle() {
    switch (st.view.kind) {
      case 'favorites': return t('views.favorites');
      case 'recent': return t('views.recent');
      case 'conflicts': return t('views.conflicts');
      case 'folder': return st.view.id ? store.folders.get(st.view.id)?.name ?? '' : t('views.root');
      default: return t('views.all');
    }
  }

  // ------------------------------------------------------------ tree
  function renderTree() {
    clear(treeEl);
    const expanded = new Set(prefs.get('expandedFolders'));
    const isActive = (kind, id = null) => st.view.kind === kind && (kind !== 'folder' || (st.view.id ?? null) === id);

    for (const q of QUICK_VIEWS) {
      treeEl.append(h(`button.tree-row.quick${isActive(q.kind) ? '.active' : ''}`, { type: 'button', onclick: () => setView({ kind: q.kind, id: null }) },
        icon(q.icon), h('span.tree-name', {}, q.label()), h('span.count', {}, String(store.notesFor({ kind: q.kind }).length || ''))));
    }
    const conflicts = store.conflictCount();
    if (conflicts) {
      treeEl.append(h(`button.tree-row.quick.conflict${isActive('conflicts') ? '.active' : ''}`, { type: 'button', onclick: () => setView({ kind: 'conflicts', id: null }) },
        icon('alert'), h('span.tree-name', {}, t('views.conflicts')), h('span.count', {}, String(conflicts))));
    }

    treeEl.append(h('div.tree-heading', {}, t('views.folders')));
    const rootRow = folderRow({ id: null, name: t('views.root') }, 0, expanded, isActive('folder', null));
    treeEl.append(rootRow);

    const walk = (parentId, depth) => {
      for (const f of store.childFolders(parentId)) {
        treeEl.append(folderRow(f, depth, expanded, isActive('folder', f.id)));
        if (expanded.has(f.id)) walk(f.id, depth + 1);
      }
    };
    walk(null, 1);
  }

  function folderRow(f, depth, expanded, active) {
    const isRoot = f.id === null;
    const hasChildren = !isRoot && store.childFolders(f.id).length > 0;
    const open = expanded.has(f.id);
    const ic = icon(isRoot ? 'notebook' : 'folder');
    if (f.color) ic.style.color = f.color;
    const count = store.notesFor({ kind: 'folder', id: f.id }).length;
    const chevron = hasChildren
      ? h('span.chev', {
        role: 'button', 'aria-label': open ? 'Comprimi' : 'Espandi',
        onpointerdown: (e) => e.stopPropagation(),
        onclick: (e) => { e.stopPropagation(); toggleExpanded(f.id); },
      }, icon(open ? 'chevronDown' : 'chevronRight'))
      : h('span.chev.none');
    const row = h(`div.tree-row.folder${active ? '.active' : ''}`, {
      role: 'button', tabIndex: 0, style: { paddingLeft: 8 + depth * 16 + 'px' },
      dataset: { dropFolder: isRoot ? 'root' : f.id },
    }, isRoot ? null : chevron, ic, h('span.tree-name', {}, f.name), h('span.count', {}, count ? String(count) : ''));
    attachGestures(row, {
      onTap: () => {
        // Opening a folder also unfolds it in the tree.
        if (hasChildren && !open) { const set = new Set(prefs.get('expandedFolders')); set.add(f.id); prefs.set('expandedFolders', [...set]); }
        setView({ kind: 'folder', id: f.id });
      },
      onMenu: (x, y) => (isRoot ? openMenu(x, y, [{ label: t('library.newFolder'), icon: 'folderPlus', action: () => createFolderIn(null) }])
        : folderMenu(f, x, y)),
      dragLabel: () => (isRoot ? null : f.name),
      onDragStart: () => { st.dragging = { kind: 'folder', id: f.id }; markInvalidTargets(f.id); },
      onDragEnd: () => { st.dragging = null; clearInvalidTargets(); },
      onDrop: (target) => act.moveFolder(f, target === 'root' ? null : target),
      onDragEdge,
    });
    return row;
  }

  function toggleExpanded(id) {
    const set = new Set(prefs.get('expandedFolders'));
    set.has(id) ? set.delete(id) : set.add(id);
    prefs.set('expandedFolders', [...set]);
    renderTree();
  }

  function expandTo(id) {
    const set = new Set(prefs.get('expandedFolders'));
    for (const f of store.folderChain(id).slice(0, -1)) set.add(f.id);
    prefs.set('expandedFolders', [...set]);
  }

  function markInvalidTargets(folderId) {
    document.querySelectorAll('[data-drop-folder]').forEach((el) => {
      const target = el.dataset.dropFolder;
      const bad = target === folderId || (target !== 'root' && store.isDescendant(target, folderId))
        || (target === 'root' && store.folders.get(folderId)?.parentId === null);
      if (bad) el.dataset.dropReject = '1';
    });
  }
  function clearInvalidTargets() { document.querySelectorAll('[data-drop-reject]').forEach((el) => delete el.dataset.dropReject); }

  // While dragging in drawer mode, touching the left edge opens the folder drawer.
  function onDragEdge(x) {
    if (root.classList.contains('drawer-mode') && !st.drawerOpen && x < 28) setDrawer(true);
  }

  function folderMenu(f, x, y) {
    openMenu(x, y, [
      { label: t('common.rename'), icon: 'edit', action: () => act.renameFolder(f) },
      { label: t('library.color'), icon: 'palette', action: () => act.pickFolderColor(f) },
      { label: t('library.newSubfolder'), icon: 'folderPlus', action: () => createFolderIn(f.id) },
      { label: t('library.move'), icon: 'folderMove', action: async () => {
        const target = await act.pickFolder({ excludeId: f.id, currentId: f.parentId });
        if (target !== undefined) act.moveFolder(f, target);
      } },
      'sep',
      { label: t('common.delete'), icon: 'trash', danger: true, action: async () => {
        const wasHere = st.view.kind === 'folder' && st.view.id && (st.view.id === f.id || store.isDescendant(st.view.id, f.id));
        if (await act.deleteFolder(f) && wasHere) setView({ kind: 'folder', id: f.parentId });
      } },
    ], { title: f.name });
  }

  async function createFolderIn(parentId) {
    const folder = await act.newFolder(parentId);
    if (folder && parentId) { expandTo(folder.id); renderTree(); }
  }

  // ------------------------------------------------------------ notes
  function visibleNotes() {
    const sort = st.view.kind === 'recent' ? 'modified' : prefs.get('librarySort');
    return sortNotes(store.notesFor(st.view), sort);
  }

  function renderNotes() {
    const notes = visibleNotes();
    const listMode = prefs.get('libraryView') === 'list';
    notesEl.className = 'notes ' + (listMode ? 'as-list' : 'as-grid');
    clear(notesEl);
    for (const n of notes) notesEl.append(noteCard(n, listMode));
    emptyEl.hidden = notes.length > 0;
    emptyEl.textContent = {
      favorites: t('library.emptyFavorites'), recent: t('library.emptyRecent'), conflicts: t('library.emptyConflicts'),
      folder: t('library.emptyFolder'), all: t('library.emptyAll'),
    }[st.view.kind];
    // Subfolder chips: quick navigation and drop targets (especially on the phone).
    clear(chipsEl);
    if (st.view.kind === 'folder') {
      for (const f of store.childFolders(st.view.id ?? null)) {
        const ic = icon('folder');
        if (f.color) ic.style.color = f.color;
        const chip = h('div.chip', { role: 'button', tabIndex: 0, dataset: { dropFolder: f.id } }, ic, h('span', {}, f.name));
        attachGestures(chip, {
          onTap: () => { expandTo(f.id); setView({ kind: 'folder', id: f.id }); },
          onMenu: (x, y) => folderMenu(f, x, y),
          dragLabel: () => f.name,
          onDragStart: () => { st.dragging = { kind: 'folder', id: f.id }; markInvalidTargets(f.id); },
          onDragEnd: () => { st.dragging = null; clearInvalidTargets(); },
          onDrop: (target) => act.moveFolder(f, target === 'root' ? null : target),
        });
        chipsEl.append(chip);
      }
    }
    chipsEl.hidden = !chipsEl.children.length;
  }

  function noteCard(n, listMode) {
    const selected = st.selection.has(n.id);
    const badges = h('div.badges', {},
      n.conflictOf ? h('span.badge.conflict', {}, t('library.conflictBadge')) : null,
      n.favorite ? h('span.badge.fav', { title: t('library.favorite') }, icon('star')) : null);
    const folder = st.view.kind !== 'folder' && n.folderId ? store.folders.get(n.folderId)?.name : null;
    const card = h(`div.note-card${selected ? '.selected' : ''}`, {
      role: 'listitem', tabIndex: 0, 'aria-selected': st.selecting ? String(selected) : null, dataset: { id: n.id },
    },
    h('div.cover-wrap', {}, renderCover(n, { small: listMode }), listMode ? null : badges, st.selecting ? h('span.check', {}, icon('check')) : null),
    h('div.note-meta', {},
      h('div.note-title', {}, n.title),
      h('div.note-sub', {}, formatDate(n.modified), folder ? h('span.note-folder', {}, ' · ' + folder) : null),
      listMode && n.snippet ? h('div.note-snippet', {}, n.snippet) : null),
    listMode ? badges : null);
    attachGestures(card, {
      onTap: (e) => onCardTap(n, e),
      onMenu: (x, y) => noteMenu(n, x, y),
      dragLabel: () => {
        const ids = dragIds(n);
        return ids.length > 1 ? t('library.selected', { n: ids.length }) : n.title;
      },
      onDragStart: () => { st.dragging = { kind: 'note', ids: dragIds(n) }; },
      onDragEnd: () => { st.dragging = null; },
      onDrop: (target) => {
        const ids = dragIds(n);
        stopSelecting();
        act.moveNotes(ids.map((id) => store.notes.get(id)).filter(Boolean), target === 'root' ? null : target);
      },
      onDragEdge,
    });
    return card;
  }

  const dragIds = (n) => (st.selection.has(n.id) && st.selection.size > 1 ? [...st.selection] : [n.id]);

  function onCardTap(n, e) {
    const multiKey = e.ctrlKey || e.metaKey;
    if (e.shiftKey && (st.selecting || st.anchor)) {
      const list = visibleNotes();
      const a = list.findIndex((x) => x.id === st.anchor);
      const b = list.findIndex((x) => x.id === n.id);
      if (a !== -1 && b !== -1) {
        st.selecting = true;
        for (let i = Math.min(a, b); i <= Math.max(a, b); i++) st.selection.add(list[i].id);
        renderSelection();
        return;
      }
    }
    if (st.selecting || multiKey) {
      st.selecting = true;
      st.selection.has(n.id) ? st.selection.delete(n.id) : st.selection.add(n.id);
      st.anchor = n.id;
      if (!st.selection.size) stopSelecting(); else renderSelection();
      return;
    }
    st.anchor = n.id;
    openNote(n.id);
  }

  function noteMenu(n, x, y) {
    openMenu(x, y, [
      { label: t('library.open'), icon: 'notes', action: () => openNote(n.id) },
      { label: t('common.rename'), icon: 'edit', action: () => act.renameNote(n) },
      { label: t('library.move'), icon: 'folderMove', action: async () => {
        const target = await act.pickFolder({ currentId: n.folderId });
        if (target !== undefined) act.moveNotes([n], target);
      } },
      { label: n.favorite ? t('library.unfavorite') : t('library.favorite'), icon: 'star', action: () => act.setFavorite([n], !n.favorite) },
      { label: t('library.cover'), icon: 'cover', action: () => openCover(n) },
      { label: t('export.pdf'), icon: 'exportPdf', action: () => exportNotes([n]) },
      { label: t('library.select'), icon: 'select', action: () => { st.selecting = true; st.selection = new Set([n.id]); st.anchor = n.id; renderSelection(); } },
      'sep',
      { label: t('common.delete'), icon: 'trash', danger: true, action: () => act.trashNotes([n]) },
    ], { title: n.title });
  }

  // ------------------------------------------------------------ selection
  function startSelecting() { st.selecting = true; st.selection = new Set(); renderSelection(); }

  function stopSelecting() {
    if (!st.selecting && !st.selection.size) return;
    st.selecting = false;
    st.selection = new Set();
    renderSelection();
  }

  function selectedNotes() { return [...st.selection].map((id) => store.notes.get(id)).filter(Boolean); }

  function renderSelection() {
    head.hidden = st.selecting;
    selBar.hidden = !st.selecting;
    fab.hidden = st.selecting;
    clear(selBar);
    if (st.selecting) {
      const notes = selectedNotes();
      const none = notes.length === 0;
      const allFav = notes.length > 0 && notes.every((n) => n.favorite);
      selBar.append(
        iconButton('close', t('common.cancel'), () => stopSelecting()),
        h('div.sel-count', {}, t('library.selected', { n: notes.length })),
        h('div.head-actions', {},
          iconButton('select', t('library.selectAll'), () => { visibleNotes().forEach((n) => st.selection.add(n.id)); renderSelection(); }),
          iconButton('folderMove', t('library.move'), async () => {
            const target = await act.pickFolder({});
            if (target !== undefined) { const list = selectedNotes(); stopSelecting(); act.moveNotes(list, target); }
          }, { disabled: none }),
          iconButton('star', allFav ? t('library.unfavorite') : t('library.favorite'), async () => {
            const list = selectedNotes(); stopSelecting(); await act.setFavorite(list, !allFav);
          }, { disabled: none }),
          iconButton('exportPdf', t('export.pdf'), () => { const list = selectedNotes(); stopSelecting(); exportNotes(list); }, { disabled: none }),
          iconButton('trash', t('common.delete'), async () => {
            if (await act.trashNotes(selectedNotes())) stopSelecting();
          }, { disabled: none, class: 'danger' })));
    }
    renderNotes();
  }

  // ------------------------------------------------------------ header actions
  function toggleView() {
    prefs.set('libraryView', prefs.get('libraryView') === 'list' ? 'grid' : 'list');
    renderHead();
    renderNotes();
  }

  function sortMenu(anchor) {
    const r = anchor.getBoundingClientRect();
    const cur = prefs.get('librarySort');
    const item = (key, label) => ({ label: (cur === key ? '✓ ' : '') + label, action: () => { prefs.set('librarySort', key); renderNotes(); } });
    openMenu(r.left, r.bottom + 4, [
      item('modified', t('library.sortModified')), item('created', t('library.sortCreated')), item('name', t('library.sortName')),
    ], { title: t('library.sort') });
  }

  function renderHead() {
    titleEl.textContent = viewTitle();
    clear(crumbEl);
    if (st.view.kind === 'folder' && st.view.id) {
      const chain = store.folderChain(st.view.id).slice(0, -1);
      const parts = [{ id: null, name: t('views.root') }, ...chain];
      parts.forEach((f, i) => {
        if (i) crumbEl.append(h('span.crumb-sep', {}, '/'));
        crumbEl.append(h('button.crumb', { type: 'button', dataset: { dropFolder: f.id ?? 'root' }, onclick: () => setView({ kind: 'folder', id: f.id }) }, f.name));
      });
    }
    const list = prefs.get('libraryView') === 'list';
    viewBtn.replaceChildren(icon(list ? 'grid' : 'list'));
    viewBtn.title = list ? t('library.grid') : t('library.list');
    viewBtn.setAttribute('aria-label', viewBtn.title);
    document.title = `${viewTitle()} · ${t('app.name')}`;
  }

  // ------------------------------------------------------------ sync indicator
  function renderSync() {
    const conflicts = store.conflictCount();
    let ic = 'cloudOk', label, cls = 'ok';
    if (store.status === 'offline') {
      ic = 'cloudOff'; cls = 'offline';
      label = store.pending ? t('sync.pending', { n: store.pending }) : t('sync.offline');
    }
    else if (store.status === 'unauthorized') { ic = 'key'; label = t('sync.unauthorized'); cls = 'offline'; }
    else if (store.status === 'checking') { ic = 'cloudSync'; label = t('sync.checking'); cls = ''; }
    else if (conflicts) { ic = 'alert'; label = t('sync.conflict', { n: conflicts }); cls = 'conflict'; }
    else if (store.pending) { ic = 'cloudSync'; label = t('sync.sending', { n: store.pending }); cls = ''; }
    else label = store.lastSync ? t('sync.okAt', { time: formatTime(new Date(store.lastSync)) }) : t('sync.ok');
    syncEl.className = 'sync ' + cls;
    syncEl.replaceChildren(icon(ic), h('span', {}, label));
    const count = trashBtn.querySelector('.count');
    count.textContent = store.trashCount ? String(store.trashCount) : '';
  }

  function onSyncTap() {
    if (store.conflictCount() && store.status === 'ok') setView({ kind: 'conflicts', id: null });
    else if (store.status === 'unauthorized') openSettings();
    else store.poll();
  }

  // ------------------------------------------------------------ render
  function render() {
    if (st.view.kind === 'folder' && st.view.id && !store.folders.has(st.view.id)) {
      st.view = { kind: 'folder', id: null };
    }
    if (st.view.kind === 'conflicts' && !store.conflictCount()) st.view = { kind: 'all', id: null };
    // Drop selections of notes that disappeared.
    for (const id of st.selection) if (!store.notes.has(id)) st.selection.delete(id);
    renderHead();
    renderTree();
    renderNotes();
    renderSync();
  }

  // While the Editor is open the Library is hidden: re-render it only when it comes back.
  let stale = false;
  store.addEventListener('change', () => {
    if (st.dragging) return;
    if (root.isConnected && !root.hidden) render(); else stale = true;
  });
  store.addEventListener('status', renderSync);
  applyLayout();
  render();

  // On the phone, the Library starts at the folder list unless a view was remembered.
  return {
    el: root,
    refresh: render,
    /** Called when the Library becomes visible again (e.g. back from the Editor). */
    shown: () => { if (stale) { stale = false; render(); } },
  };
}

/** The app mark (also used as the favicon/app icon motif). */
export function appMark() {
  const s = document.createElement('span');
  s.className = 'app-mark';
  s.innerHTML = '<svg viewBox="0 0 32 32" aria-hidden="true"><rect x="7" y="4" width="18" height="24" rx="2.5" fill="#F3EEE3"/><path d="M11 4v24" stroke="#C9C1B1" stroke-width="1.2"/><path d="M14 11h7M14 15h7M14 19h4" stroke="#B9C6D8" stroke-width="1.2" stroke-linecap="round"/><path d="M12.5 22.5c2.5-2.2 5-4.8 9-4" stroke="#E9A23B" stroke-width="2.2" stroke-linecap="round" fill="none"/></svg>';
  return s;
}
