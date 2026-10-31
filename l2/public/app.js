const $ = (selector) => document.querySelector(selector);
const form = $("#quote-form");
const fields = ["text", "author", "category"];
let editing = null;

function message(value = "", error = false) {
  $("#message").textContent = value;
  $("#message").classList.toggle("error", error);
}

function node(tag, text, cls) {
  const element = document.createElement(tag);
  if (text !== undefined) element.textContent = text;
  if (cls) element.className = cls;
  return element;
}

async function api(path, options = {}) {
  if (options.body && !(options.body instanceof FormData)) {
    options.headers = { "Content-Type": "application/json" };
    options.body = JSON.stringify(options.body);
  }
  const response = await fetch(path, options);
  const data = response.status === 204 ? null : await response.json();
  if (!response.ok) throw new Error(data.error || "Ошибка запроса");
  return data;
}

function resetForm() {
  editing = null;
  form.reset();
  $("#form-title").textContent = "Добавить цитату";
  $("#remove-image-label").hidden = true;
}

function render(quotes) {
  $("#list").replaceChildren();
  if (!quotes.length) $("#list").append(node("p", "Цитаты не найдены"));
  for (const quote of quotes) {
    const card = node("article");
    card.append(node("blockquote", quote.text), node("p", quote.author), node("p", quote.category, "tag"));
    if (quote.image) {
      const image = node("img");
      image.src = quote.image;
      image.alt = "Иллюстрация к цитате";
      card.append(image);
    }
    const actions = node("div", undefined, "actions");
    const edit = node("button", "Изменить", "secondary");
    edit.onclick = () => {
      resetForm();
      editing = quote;
      $("#form-title").textContent = "Изменить цитату";
      for (const field of fields) form.elements[field].value = quote[field];
      $("#remove-image-label").hidden = !quote.image;
    };
    const remove = node("button", "Удалить", "secondary");
    remove.onclick = async () => {
      try {
        await api("/api/quotes/" + quote.id, { method: "DELETE" });
        if (editing?.id === quote.id) resetForm();
        await load();
        message("Цитата удалена");
      } catch (error) {
        message(error.message, true);
      }
    };
    actions.append(edit, remove);
    card.append(actions);
    $("#list").append(card);
  }
}

async function load() {
  render(await api("/api/quotes"));
}

$("#cancel").onclick = resetForm;
form.onsubmit = async (event) => {
  event.preventDefault();
  const submit = form.querySelector("button");
  submit.disabled = true;
  try {
    const data = Object.fromEntries(fields.map((key) => [key, form.elements[key].value]));
    const quote = await api("/api/quotes" + (editing ? "/" + editing.id : ""), {
      method: editing ? "PUT" : "POST",
      body: data,
    });
    try {
      const image = form.elements.image.files[0];
      if (image) {
        const upload = new FormData();
        upload.append("image", image);
        await api("/api/quotes/" + quote.id + "/image", { method: "POST", body: upload });
      } else if (editing && $("#remove-image").checked) {
        await api("/api/quotes/" + quote.id + "/image", { method: "DELETE" });
      }
    } catch (error) {
      resetForm();
      await load();
      throw new Error("Цитата сохранена, но изображение: " + error.message);
    }
    resetForm();
    await load();
    message("Сохранено");
  } catch (error) {
    message(error.message, true);
  } finally {
    submit.disabled = false;
  }
};

load().catch((error) => message(error.message, true));
