const express = require("express");
const path = require("path");
const quotesStore = require("./quotes");

const app = express();
const PORT = process.env.PORT || 3000;

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "..", "views"));

app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "..", "public")));

app.get("/", (req, res) => {
  const selectedAuthor = req.query.author || "";
  const editId = req.query.edit || null;
  const quotes = quotesStore.getAll(selectedAuthor);
  const randomQuote = quotesStore.getRandom(selectedAuthor);
  const editQuote = editId ? quotesStore.getById(editId) : null;
  res.render("index", {
    quotes,
    authors: quotesStore.authors,
    selectedAuthor,
    randomQuote,
    editQuote,
    message: req.query.msg || null
  });
});

app.post("/quotes", (req, res) => {
  const { author, text } = req.body;
  if (!author || !text || !text.trim()) {
    return res.redirect("/?msg=error");
  }
  quotesStore.add(author, text);
  res.redirect("/?msg=added");
});

app.post("/quotes/update", (req, res) => {
  const { id, author, text } = req.body;
  if (!id || !author || !text || !text.trim()) {
    return res.redirect("/?msg=error");
  }
  const updated = quotesStore.update(id, author, text);
  res.redirect(updated ? "/?msg=updated" : "/?msg=error");
});

app.post("/quotes/delete", (req, res) => {
  const { id } = req.body;
  if (id) {
    quotesStore.deleteById(id);
  }
  res.redirect("/?msg=deleted");
});

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
