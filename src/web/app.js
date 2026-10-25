import { statuses, errors } from './labels.js';
import { prepareWrite } from './retry.js';

const $ = id => document.getElementById(id);
let token = '', session = null, current = null, tickets = [], messages = [];
let ticketCursor = null, messageCursor = null, busy = false;
let selection = 0;
function notify(value, error = false) {
  $('feedback').textContent = value;
  $('feedback').dataset.error = String(error);
}
function storageKey(name) {
  return JSON.stringify(['support-v1', session.principal.tenant, session.principal.subject, session.principal.role, name]);
}
function saved(name) { try { return JSON.parse(sessionStorage.getItem(storageKey(name))); } catch { return null; } }
function save(name, value) { try { sessionStorage.setItem(storageKey(name), JSON.stringify(value)); } catch { /* In-memory form still works when storage is unavailable. */ } }
function remove(name) { try { sessionStorage.removeItem(storageKey(name)); } catch { /* No storage. */ } }
async function api(path, command) {
  const headers = { Authorization: `Bearer ${token}` };
  let pending;
  let recoveryOnly = false;
  if (command) {
    const cached = saved(`pending:${path}`);
    ({ pending, recoveryOnly } = prepareWrite(cached, command, () => crypto.randomUUID()));
    save(`pending:${path}`, pending);
    headers['Content-Type'] = 'application/json';
    headers['Idempotency-Key'] = pending.key;
  }
  let response;
  try {
    response = await fetch(`/api/v1${path}`, { method: command ? 'POST' : 'GET', headers, ...(command ? { body: pending.payload } : {}) });
  } catch { throw new Error(errors.service_unavailable); }
  const data = await response.json();
  if (!response.ok) {
    // Definitive validation/conflict responses permit a corrected command with a new key.
    if (command && response.status >= 400 && response.status < 500 && response.status !== 429) remove(`pending:${path}`);
    throw new Error(errors[data.error] ?? `Запрос отклонён (${data.error ?? response.status}).`);
  }
  if (command) remove(`pending:${path}`);
  if (recoveryOnly) throw new Error('Предыдущая отправка подтверждена. Обновите историю перед отправкой нового текста; текущий черновик сохранён.');
  return data;
}
async function action(work) {
  if (busy) return;
  busy = true;
  document.querySelectorAll('button').forEach(button => { button.disabled = true; });
  try { await work(); } catch (error) { notify(error.message, true); }
  finally { busy = false; document.querySelectorAll('button').forEach(button => { button.disabled = false; }); }
}
function button(label, onClick) {
  const element = document.createElement('button');
  element.textContent = label;
  element.addEventListener('click', () => action(onClick));
  return element;
}
function renderTickets() {
  $('tickets').replaceChildren();
  for (const ticket of tickets) {
    const item = button(ticket.subject, () => openTicket(ticket.id));
    item.className = 'ticket';
    item.setAttribute('aria-current', String(ticket.id === current?.id));
    const detail = document.createElement('small');
    detail.textContent = `№${ticket.seq} · ${statuses[ticket.status]}`;
    item.append(detail);
    $('tickets').append(item);
  }
  if (!tickets.length) $('tickets').textContent = 'Обращений пока нет.';
  $('more-tickets').hidden = !ticketCursor;
}
async function loadTickets(more = false) {
  const page = await api(`/tickets${more && ticketCursor ? `?before=${ticketCursor}` : ''}`);
  tickets = more ? [...tickets, ...page.items] : page.items;
  ticketCursor = page.nextCursor;
  renderTickets();
}
function renderMessages() {
  $('messages').replaceChildren();
  for (const message of [...messages].reverse()) {
    const article = document.createElement('article');
    article.className = `message ${message.visibility === 'internal' ? 'internal' : ''}`;
    const meta = document.createElement('small');
    meta.textContent = `${message.author_role === 'operator' ? 'Оператор' : 'Пользователь'} · ${new Date(message.created_at).toLocaleString('ru-RU')}${message.visibility === 'internal' ? ' · Внутренняя заметка' : ''}`;
    const paragraph = document.createElement('p');
    paragraph.textContent = message.body;
    article.append(meta, paragraph);
    $('messages').append(article);
  }
  $('more-messages').hidden = !messageCursor;
}
async function openTicket(id) {
  const request = ++selection;
  const [ticket, page] = await Promise.all([api(`/tickets/${id}`), api(`/tickets/${id}/messages`)]);
  if (request !== selection) return;
  current = ticket;
  messages = page.items;
  messageCursor = page.nextCursor;
  $('empty').hidden = true;
  $('detail').hidden = false;
  $('ticket-number').textContent = `ОБРАЩЕНИЕ №${ticket.seq}`;
  $('ticket-subject').textContent = ticket.subject;
  $('ticket-state').textContent = `${statuses[ticket.status]} · Версия ${ticket.version}${session.principal.role === 'operator' ? ` · Ответственный: ${ticket.assignee ?? 'не назначен'}` : ''}`;
  const draft = saved(`reply:${id}`);
  $('reply-body').value = draft?.body ?? '';
  $('internal').checked = draft?.internal ?? false;
  $('status').replaceChildren(...ticket.allowedTransitions.map(status => {
    const option = document.createElement('option');
    option.value = status;
    option.textContent = statuses[status];
    return option;
  }));
  renderMessages();
  renderTickets();
}
function replyDraft() {
  if (current) save(`reply:${current.id}`, { body: $('reply-body').value, internal: $('internal').checked });
}
function createDraft() { save('create', { subject: $('subject').value, body: $('description').value }); }
$('subject').addEventListener('input', createDraft);
$('description').addEventListener('input', createDraft);
$('reply-body').addEventListener('input', replyDraft);
$('internal').addEventListener('change', replyDraft);
$('login').addEventListener('submit', event => {
  event.preventDefault();
  action(async () => {
    token = $('token').value.trim();
    session = await api('/session');
    $('token').value = '';
    const isOperator = session.principal.role === 'operator';
    $('identity').textContent = `${session.principal.tenant} / ${session.principal.subject}`;
    $('list-title').textContent = isOperator ? 'Очередь обращений' : 'Мои обращения';
    $('create-panel').hidden = isOperator;
    $('operator-actions').hidden = !isOperator;
    $('note-control').hidden = !isOperator;
    $('subject').maxLength = session.policy.subjectLength;
    for (const id of ['description', 'reply-body']) $(id).maxLength = session.policy.messageLength;
    const draft = saved('create');
    $('subject').value = draft?.subject ?? '';
    $('description').value = draft?.body ?? '';
    $('login-panel').hidden = true;
    $('workspace').hidden = false;
    $('logout').hidden = false;
    await loadTickets();
    notify('Вход выполнен.');
  });
});
$('logout').addEventListener('click', () => {
  // A shared browser must not retain an operator's unsent private note after logout.
  try {
    for (const key of Object.keys(sessionStorage)) {
      let parts;
      try { parts = JSON.parse(key); } catch { continue; }
      const owner = ['support-v1', session.principal.tenant, session.principal.subject, session.principal.role];
      if (Array.isArray(parts) && owner.every((value, index) => parts[index] === value)) sessionStorage.removeItem(key);
    }
  } catch { /* Storage can be unavailable. */ }
  token = ''; session = null; current = null; tickets = []; messages = []; ++selection;
  $('tickets').replaceChildren(); $('messages').replaceChildren();
  for (const id of ['subject', 'description', 'reply-body', 'token']) $(id).value = '';
  $('ticket-subject').textContent = ''; $('ticket-state').textContent = ''; $('identity').textContent = '';
  $('workspace').hidden = true; $('detail').hidden = true; $('empty').hidden = false;
  $('login-panel').hidden = false; $('logout').hidden = true;
  notify('Вы вышли.');
});
$('create').addEventListener('submit', event => {
  event.preventDefault();
  action(async () => {
    const receipt = await api('/tickets', { subject: $('subject').value, body: $('description').value });
    remove('create'); $('subject').value = ''; $('description').value = '';
    await loadTickets(); await openTicket(receipt.id);
    notify('Обращение принято и сохранено.');
  });
});
$('reply').addEventListener('submit', event => {
  event.preventDefault();
  action(async () => {
    const id = current.id;
    await api(`/tickets/${id}/commands`, { type: 'message', version: current.version, body: $('reply-body').value,
      visibility: session.principal.role === 'operator' && $('internal').checked ? 'internal' : 'public' });
    remove(`reply:${id}`); await openTicket(id); await loadTickets();
    notify('Сообщение сохранено.');
  });
});
async function change(command) {
  const id = current.id;
  await api(`/tickets/${id}/commands`, { ...command, version: current.version });
  await openTicket(id); await loadTickets(); notify('Изменение сохранено.');
}
$('status-form').addEventListener('submit', event => { event.preventDefault(); action(() => change({ type: 'status', status: $('status').value })); });
$('assign').addEventListener('click', () => action(() => change({ type: 'assignment', assigned: true })));
$('unassign').addEventListener('click', () => action(() => change({ type: 'assignment', assigned: false })));
$('refresh').addEventListener('click', () => action(async () => { await loadTickets(); if (current) await openTicket(current.id); notify('Обновлено.'); }));
$('more-tickets').addEventListener('click', () => action(() => loadTickets(true)));
$('more-messages').addEventListener('click', () => action(async () => {
  const page = await api(`/tickets/${current.id}/messages?before=${messageCursor}`);
  messages.push(...page.items); messageCursor = page.nextCursor; renderMessages();
}));
