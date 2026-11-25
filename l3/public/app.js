const byId = id => document.getElementById(id);
const emailForm = byId("email-form");
const codeForm = byId("code-form");
const quoteForm = byId("quote-form");
const roles = { reader: "Читатель", editor: "Редактор", admin: "Администратор" };
const date = value => new Date(value).toLocaleString("ru");
let token = localStorage.getItem("quotes-session");
let user;
let email;
let editing;
let screen = "workspace";

function text(tag, value, cssClass) {
  const element = document.createElement(tag);
  element.textContent = value;
  if (cssClass) element.className = cssClass;
  return element;
}

function button(label, action) {
  const element = text("button", label, "secondary");
  element.type = "button";
  element.onclick = () => run(element, action);
  return element;
}

function message(value, error = false) {
  byId("message").textContent = value;
  byId("message").classList.toggle("error", error);
}

async function run(control, action) {
  message("");
  if (control) control.disabled = true;
  try {
    await action();
  } catch (error) {
    message(error.message, true);
  } finally {
    if (control) control.disabled = false;
  }
}

async function request(path, method = "GET", data, requiresSession = true) {
  const headers = {};
  if (requiresSession && token) headers.Authorization = "Bearer " + token;
  const multipart = data instanceof FormData;
  if (data && !multipart) headers["Content-Type"] = "application/json";
  const response = await fetch("/api" + path, {
    method, headers, body: multipart ? data : JSON.stringify(data),
  });
  if (response.status === 204) return null;
  const result = await response.json();
  if (!response.ok) {
    if (response.status === 401 && requiresSession) leave();
    throw new Error(result.error || "Ошибка запроса");
  }
  return result;
}

function show(name) {
  screen = name;
  const allowed = Boolean(user);
  const canEdit = allowed && user.role !== "reader";
  byId("login").hidden = allowed;
  byId("account").hidden = !allowed;
  byId("account-name").textContent = allowed ? user.email + " · " + roles[user.role] : "";
  byId("show-users").hidden = user?.role !== "admin";
  byId("editor").hidden = !canEdit;
  byId("workspace").classList.toggle("read-only", !canEdit);
  for (const panel of ["workspace", "sessions", "users"]) {
    byId(panel).hidden = !allowed || panel !== screen || (panel === "users" && user.role !== "admin");
  }
}

function leave() {
  token = null;
  user = null;
  email = null;
  localStorage.removeItem("quotes-session");
  emailForm.reset();
  codeForm.reset();
  emailForm.hidden = false;
  codeForm.hidden = true;
  quoteForm.reset();
  editing = null;
  show("workspace");
}

function editQuote(quote = null) {
  editing = quote;
  quoteForm.reset();
  byId("form-title").textContent = quote ? "Изменить цитату" : "Добавить цитату";
  byId("remove-image-label").hidden = !quote?.image;
  if (quote) {
    for (const field of ["text", "author", "category"]) quoteForm.elements[field].value = quote[field];
    quoteForm.elements.text.focus();
  }
}

async function loadQuotes() {
  const value = byId("search").elements.q.value;
  const quotes = await request("/quotes?q=" + encodeURIComponent(value));
  const cards = quotes.map(quote => {
    const card = document.createElement("article");
    card.append(text("blockquote", quote.text), text("p", quote.author + " · " + quote.category, "muted"));
    if (quote.image) {
      const image = document.createElement("img");
      image.src = quote.image;
      image.alt = "Иллюстрация к цитате";
      card.append(image);
    }
    if (user && user.role !== "reader") {
      const actions = text("div", "", "actions");
      actions.append(button("Изменить", () => editQuote(quote)), button("Удалить", async () => {
        if (!confirm("Удалить цитату?")) return;
        await request("/quotes/" + quote.id, "DELETE");
        if (editing?.id === quote.id) editQuote();
        await loadQuotes();
      }));
      card.append(actions);
    }
    return card;
  });
  byId("list").replaceChildren(...(cards.length ? cards : [text("p", "Цитаты не найдены.")]));
}

quoteForm.onsubmit = event => {
  event.preventDefault();
  return run(event.submitter, async () => {
    const form = new FormData(quoteForm);
    const file = form.get("image");
    if (file.size > 2097152) throw new Error("Изображение больше 2 МБ");
    const removeImage = byId("remove-image").checked;
    const values = { text: form.get("text"), author: form.get("author"), category: form.get("category") };
    if (editing) values.version = editing.version;
    const quote = await request(editing ? "/quotes/" + editing.id : "/quotes", editing ? "PUT" : "POST", values);
    editing = quote;
    byId("form-title").textContent = "Изменить цитату";
    if (file.size) {
      const upload = new FormData();
      upload.append("image", file);
      await request("/quotes/" + quote.id + "/image", "POST", upload);
    } else if (removeImage) {
      await request("/quotes/" + quote.id + "/image", "DELETE");
    }
    editQuote();
    await loadQuotes();
    message("Цитата сохранена");
  });
};

byId("cancel").onclick = () => editQuote();
byId("search").onsubmit = event => {
  event.preventDefault();
  return run(event.submitter, loadQuotes);
};

async function loadSessions() {
  const sessions = await request("/auth/sessions");
  byId("session-list").replaceChildren(...sessions.map(session => {
    const current = session.id === user.session_id;
    const card = document.createElement("article");
    card.append(text("strong", current ? "Текущее подключение" : session.ip), text("p", session.agent, "muted"),
      text("p", "Активность " + date(session.last_seen) + " · действует до " + date(session.expires_at)));
    card.append(button("Завершить", async () => {
      await request("/auth/sessions/" + session.id, "DELETE");
      if (current) leave();
      else await loadSessions();
    }));
    return card;
  }));
}

async function loadUsers() {
  const accounts = await request("/users");
  byId("user-list").replaceChildren(...accounts.map(account => {
    const controls = text("div", "", "toolbar");
    const select = document.createElement("select");
    select.setAttribute("aria-label", "Роль " + account.email);
    for (const [key, label] of Object.entries(roles)) select.add(new Option(label, key, false, key === account.role));
    select.disabled = account.id === user.id;
    controls.append(text("strong", account.email), select);
    if (!select.disabled) controls.append(button("Сохранить роль", async () => {
      await request("/users/" + account.id, "PUT", { role: select.value });
      message("Роль обновлена");
    }));
    return controls;
  }));
}

for (const [id, panel, load] of [
  ["show-quotes", "workspace", loadQuotes],
  ["show-sessions", "sessions", loadSessions],
  ["show-users", "users", loadUsers],
]) {
  byId(id).onclick = event => run(event.currentTarget, async () => {
    user = await request("/auth/me");
    show(panel);
    if (panel === "users" && user.role !== "admin") {
      show("workspace");
      await loadQuotes();
    } else {
      await load();
    }
  });
}

byId("logout").onclick = event => run(event.currentTarget, async () => {
  await request("/auth/logout", "POST");
  leave();
});

async function sendCode(address) {
  await request("/auth/code", "POST", { email: address }, false);
  email = address;
  emailForm.hidden = true;
  codeForm.hidden = false;
  byId("code-email").textContent = email;
  codeForm.reset();
  codeForm.elements.code.focus();
  message("Код отправлен");
}

emailForm.onsubmit = event => {
  event.preventDefault();
  return run(event.submitter, () => sendCode(emailForm.elements.email.value.trim().toLowerCase()));
};

byId("resend-code").onclick = event => run(event.currentTarget, () => sendCode(email));
byId("change-email").onclick = () => {
  codeForm.hidden = true;
  emailForm.hidden = false;
  emailForm.elements.email.focus();
  message("");
};

codeForm.onsubmit = event => {
  event.preventDefault();
  return run(event.submitter, async () => {
    const result = await request("/auth/login", "POST", { email, code: codeForm.elements.code.value }, false);
    token = result.token;
    user = result.user;
    localStorage.setItem("quotes-session", token);
    editQuote();
    show("workspace");
    await loadQuotes();
  });
};

if (token) void run(null, async () => {
  user = await request("/auth/me");
  show("workspace");
  await loadQuotes();
});
