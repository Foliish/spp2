const el = id => document.getElementById(id);
const form = el("search");
const formatter = new Intl.NumberFormat("ru");
const labels = { MOVIE: "Фильм", SERIES: "Сериал", LOCATION: "Место съёмок" };
let owner = localStorage.getItem("spp5-collection");
if (!owner) {
  owner = Array.from(crypto.getRandomValues(new Uint8Array(24)), n => n.toString(16).padStart(2, "0")).join("");
  localStorage.setItem("spp5-collection", owner);
}

let page = 1, mode = "catalog", retry, serial = 0;
let filter = {}, order = "TITLE_ASC";
const selections = {
  details: "details { ratingCount language network country status location neighborhood director cast }",
  publisher: "source { name publisher { name url } }",
  collection: "savedByMe",
};

async function graph(query, variables = {}) {
  const response = await fetch("/graphql", { method: "POST",
    signal: AbortSignal.timeout(8000), headers: { "Content-Type": "application/json", "x-collection": owner },
    body: JSON.stringify({ query, variables }),
  });
  const result = await response.json();
  if (!result.data) throw new Error(result.errors?.[0]?.message || "Нет связи с GraphQL");
  return result;
}

function paragraph(parent, value, className) {
  if (!value) return;
  const p = document.createElement("p");
  if (className) p.className = className;
  p.textContent = value;
  parent.append(p);
}
function link(parent, text, href) {
  if (!href || !/^https?:\/\//i.test(href)) return;
  const a = document.createElement("a");
  a.textContent = text;
  a.href = href;
  a.target = "_blank";
  a.rel = "noopener noreferrer";
  parent.append(a);
}

function render(entries) {
  el("results").replaceChildren(...entries.filter(e => e?.title).map(e => {
    const card = document.createElement("article");
    const title = document.createElement("h2");
    title.textContent = e.title;
    card.append(title);
    paragraph(card, [labels[e.kind], e.year, e.source.name, ...e.genres].filter(Boolean).join(" · "), "muted");
    if (e.rating !== null) paragraph(card, "Рейтинг " + e.rating + " / 10" +
      (e.details?.ratingCount ? ` · голосов ${formatter.format(e.details.ratingCount)}` : ""));
    if (e.details) {
      paragraph(card, [e.details.location, e.details.neighborhood].filter(Boolean).join(" · "));
      paragraph(card, [e.details.network, e.details.country, e.details.language, e.details.status].filter(Boolean).join(" · "));
      paragraph(card, e.details.director && "Режиссёр " + e.details.director);
      paragraph(card, e.details.cast?.join(", "));
    }
    const actions = document.createElement("div");
    actions.className = "actions";
    link(actions, "Карточка источника", e.url || e.source.url);
    if (e.source.publisher) link(actions, e.source.publisher.name, e.source.publisher.url);
    if (typeof e.savedByMe === "boolean" || mode === "saved") {
      const button = document.createElement("button");
      button.className = "secondary";
      const saved = mode === "saved" || e.savedByMe;
      button.textContent = saved ? "Убрать из избранного" : "В избранное";
      button.onclick = async () => {
        button.disabled = true;
        try {
          await graph("mutation Save($id:ID!,$save:Boolean!){ setSaved(id:$id,save:$save){ id savedByMe } }",
            { id: e.id, save: !saved });
          await load();
        } catch (error) {
          el("notice").textContent = error.message;
          button.disabled = false;
        }
      };
      actions.append(button);
    }
    card.append(actions);
    return card;
  }));
}

async function load() {
  const request = ++serial;
  const state = mode;
  const selected = Object.entries(selections).filter(([id]) => el(id).checked).map(([, value]) => "\n      " + value).join("");
  const fields = "id title year kind genres rating url source { name url }" + selected;
  const query = state === "catalog" ? `query Browse($filter: EntryFilter, $order: EntryOrder!, $page: Int!) {
  entries(filter: $filter, order: $order, page: $page, size: 15) {
    total page pages
    items {
      ${fields}
    }
  }
}` : `query Favorites {
  savedEntries {
      ${fields}
  }
}`;
  el("notice").textContent = "Загрузка…";
  try {
    const { data, errors, extensions } = await graph(query, state === "catalog" ? { filter, order, page } : {});
    if (request !== serial) return;
    el("query").textContent = query;
    el("trace").textContent = extensions ? `Трасса ${extensions.traceId} · ${extensions.durationMs} мс` : "";
    const count = state === "catalog" ? data.entries?.total : data.savedEntries?.filter(e => e?.title).length;
    const entries = state === "catalog" ? data.entries?.items : data.savedEntries;
    el("notice").textContent = errors?.length ? "Часть данных временно недоступна." :
      count ? `Найдено ${formatter.format(count)}` : state === "saved" ? "Избранное пока пусто." : "Записи не найдены.";
    render(entries || []);
    el("pagination").hidden = state !== "catalog" || !data.entries?.pages;
    if (data.entries) {
      el("page").textContent = `${data.entries.page} / ${data.entries.pages}`;
      el("prev").disabled = page <= 1;
      el("next").disabled = page >= data.entries.pages;
    }
  } catch (error) {
    if (request === serial) el("notice").textContent = error.message;
  }
}

async function status() {
  clearTimeout(retry);
  try {
    const result = await graph("query Status { catalog { count syncing genres sources { id name url count updatedAt error } } }");
    const data = result.data.catalog;
    const count = formatter.format(data.count);
    el("total").textContent = data.syncing ? `${count} записей · импорт` : `${count} записей`;
    el("sources").replaceChildren(...data.sources.map(src => {
      const li = document.createElement("li");
      link(li, src.name, src.url);
      li.append(document.createTextNode(" · " + formatter.format(src.count) + (src.error ? " · сохранённые данные" : "")));
      if (src.updatedAt) li.title = "Последний импорт " + new Date(src.updatedAt).toLocaleString("ru");
      return li;
    }));
    for (const [id, choices] of [["source", data.sources.map(s => [s.id, s.name])], ["genre", data.genres.map(g => [g, g])]]) {
      const select = el(id);
      const selected = select.value;
      select.replaceChildren(new Option("Все", ""), ...choices.map(([value, label]) => new Option(label, value)));
      select.value = choices.some(([value]) => value === selected) ? selected : "";
    }
    if (data.syncing || data.sources.some(s => !s.updatedAt)) retry = setTimeout(async () => { await status(); await load(); }, 5000);
  } catch {
    el("total").textContent = "Источники недоступны";
    retry = setTimeout(status, 15000);
  }
}

form.onsubmit = e => {
  e.preventDefault();
  const { text, kind, source, genre, year, order: selectedOrder } = Object.fromEntries(new FormData(form));
  filter = { text, kind: kind || null, source: source || null, genre, year: year ? Number(year) : null };
  order = selectedOrder;
  page = 1;
  void load();
};
form.onreset = () => { filter = {}; order = "TITLE_ASC"; page = 1; void load(); };
for (const id of Object.keys(selections)) el(id).onchange = load;
el("prev").onclick = () => { page--; void load(); };
el("next").onclick = () => { page++; void load(); };
el("refresh").onclick = async () => { await status(); await load(); };
for (const view of ["catalog", "saved"]) {
  el(view + "-tab").onclick = () => {
    mode = view;
    el("filters").hidden = mode !== "catalog";
    for (const btn of ["catalog", "saved"]) {
      el(btn + "-tab").classList.toggle("secondary", btn !== mode);
      el(btn + "-tab").setAttribute("aria-pressed", String(btn === mode));
    }
    void load();
  };
}
void status();
void load();
