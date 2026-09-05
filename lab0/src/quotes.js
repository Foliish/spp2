const quotes = [
  { id: 1, author: "Джейсон Стетхем", text: "Лучше быть последним — первым, чем первым — последним." },
  { id: 2, author: "Джейсон Стетхем", text: "Если волк молчит, то лучше его не перебивать." },
  { id: 3, author: "Шрек", text: "Огры — они как лук. Лук имеет слои. И у огров есть слои!" },
  { id: 4, author: "Шрек", text: "Что вы делаете на моём болоте?!" },
  { id: 5, author: "Александр Лукашенко", text: "Я своё государство за цивилизованным миром не поведу!" },
  { id: 6, author: "Александр Лукашенко", text: "Жить будете плохо, но недолго." },
  { id: 7, author: "Камина", text: "Не верь в себя! Верь в меня, который верит в тебя!" },
  { id: 8, author: "Камина", text: "Стисни зубы и смотри вперёд! Наш бур пронзит небеса!" },
  { id: 9, author: "Альберт Эйнштейн", text: "Только дурак нуждается в порядке — гений господствует над хаосом." },
  { id: 10, author: "Альберт Эйнштейн", text: "Безумие — делать одно и то же снова и снова, ожидая при этом разных результатов." }
];
const authors = [
  "Джейсон Стетхем",
  "Шрек",
  "Александр Лукашенко",
  "Камина",
  "Альберт Эйнштейн"
];
let nextId = 11;
module.exports = {
  authors,
  getAll: (authorFilter = "") => {
    if (!authorFilter) return quotes;
    return quotes.filter(q => q.author === authorFilter);
  },
  getById: (id) => {
    return quotes.find(q => q.id === Number(id)) || null;
  },
  getRandom: (authorFilter = "") => {
    const list = authorFilter ? quotes.filter(q => q.author === authorFilter) : quotes;
    if (list.length === 0) return null;
    return list[Math.floor(Math.random() * list.length)];
  },
  add: (author, text) => {
    const item = { id: nextId++, author: author.trim(), text: text.trim() };
    quotes.unshift(item);
    return item;
  },
  update: (id, author, text) => {
    const item = quotes.find(q => q.id === Number(id));
    if (item) {
      item.author = author.trim();
      item.text = text.trim();
      return true;
    }
    return false;
  },
  deleteById: (id) => {
    const idx = quotes.findIndex(q => q.id === Number(id));
    if (idx !== -1) {
      quotes.splice(idx, 1);
      return true;
    }
    return false;
  }
};