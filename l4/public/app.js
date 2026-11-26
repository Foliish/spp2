import { FIRST_GATE, GAP, GATE_WIDTH, HEIGHT, RADIUS, SPACING, START_X, WIDTH, gate } from "./game.js";

const byId = id => document.getElementById(id);
const colors = ["#4e7653", "#b7613e", "#497dbc", "#9262ab", "#9b7534", "#237e81", "#b35379", "#687046"];
const canvas = byId("track");
const ctx = canvas.getContext("2d");
let token = localStorage.getItem("spp4-flight");
let socket, playerId, state, retry;
let name = "";
let connected = false;

function connect() {
  if (!token && !name) return;
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  const current = socket = new WebSocket(protocol + "//" + location.host + "/play");
  byId("status").textContent = "Подключение…";
  current.onopen = () => current.send(JSON.stringify({ type: "join", token, name }));
  current.onmessage = event => {
    if (current !== socket) return;
    const message = JSON.parse(event.data);
    if (message.type === "joined") {
      token = message.token;
      playerId = message.id;
      connected = true;
      localStorage.setItem("spp4-flight", token);
      byId("game").hidden = false;
      byId("entry").hidden = true;
      byId("status").textContent = "На связи";
    } else if (message.type === "state") {
      state = message;
      render();
    } else if (message.type === "error" || message.type === "conflict") {
      byId("status").textContent = message.message;
      if (message.type === "error") {
        socket = null;
        token = null;
        name = "";
        localStorage.removeItem("spp4-flight");
        byId("game").hidden = true;
        byId("entry").hidden = false;
        current.close();
      }
    }
  };
  current.onclose = () => {
    if (current !== socket) return;
    connected = false;
    byId("flap").disabled = true;
    byId("status").textContent = "Связь потеряна. Переподключение…";
    retry = setTimeout(connect, 1000);
  };
}

function draw(me) {
  const camera = me.x - START_X;
  ctx.fillStyle = "#f3f1e9";
  ctx.fillRect(0, 0, WIDTH, HEIGHT);
  ctx.strokeStyle = "#e0ddd0";
  for (let x = -(camera % 60); x < WIDTH; x += 60) {
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, HEIGHT); ctx.stroke();
  }
  ctx.fillStyle = "#6b7262";
  ctx.fillRect(0, 0, WIDTH, 7);
  ctx.fillRect(0, HEIGHT - 7, WIDTH, 7);
  const first = Math.max(0, Math.floor((camera - FIRST_GATE) / SPACING));
  for (let i = first; gate(i).x < camera + WIDTH; i++) {
    const { x, y } = gate(i);
    ctx.fillRect(x - camera, 0, GATE_WIDTH, y - GAP / 2);
    ctx.fillRect(x - camera, y + GAP / 2, GATE_WIDTH, HEIGHT - y - GAP / 2);
  }
  for (const p of [...state.visible.filter(p => p.id !== playerId), me]) {
    if (p.x - camera < -RADIUS || p.x - camera > WIDTH + RADIUS) continue;
    ctx.globalAlpha = p.id === playerId ? 1 : .55;
    ctx.fillStyle = colors[p.color];
    ctx.beginPath(); ctx.arc(p.x - camera, p.y, RADIUS, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = "#fff";
    ctx.beginPath(); ctx.arc(p.x - camera - 4, p.y - 4, 3, 0, Math.PI * 2); ctx.fill();
  }
  ctx.globalAlpha = 1;
}

let board = "";
function render() {
  const me = state.visible.find(p => p.id === playerId);
  if (!me) return;
  draw(me);
  byId("score").textContent = "Счёт " + me.points;
  const labels = { ready: ["Старт", "Пробел, щелчок по трассе или кнопка поднимают шар."],
    flying: ["Поднять шар", "Удерживайте шар между верхней и нижней стенками."],
    paused: ["Продолжить", "Попытка сохранена. Нажмите, чтобы продолжить."],
    over: ["Ещё раз", "Столкновение. Начните новую попытку."] };
  [byId("flap").textContent, byId("hint").textContent] = labels[me.phase];
  byId("flap").disabled = !connected;
  const key = JSON.stringify(state.leaders);
  if (board === key) return;
  board = key;
  byId("leaders").replaceChildren(...state.leaders.map(p => {
    const li = document.createElement("li");
    const marker = document.createElement("span");
    marker.className = "marker";
    marker.style.background = p.online ? colors[p.color] : "#aaa99e";
    marker.title = p.online ? "На связи" : "Вне сети";
    li.append(marker, document.createTextNode(`${p.name} — ${p.best}${p.id === playerId ? " (вы)" : ""}`));
    return li;
  }));
}

function flap() {
  const me = state?.visible.find(p => p.id === playerId);
  if (connected && me && socket?.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ type: "flap", version: me.version }));
  }
}
byId("join").onsubmit = event => {
  event.preventDefault();
  if (socket) return;
  name = event.currentTarget.elements.nickname.value.trim();
  connect();
};
byId("flap").onclick = flap;
canvas.onpointerdown = flap;
window.addEventListener("keydown", event => {
  if (event.code !== "Space" || event.repeat || byId("game").hidden ||
      ["INPUT", "TEXTAREA", "BUTTON"].includes(document.activeElement.tagName)) return;
  event.preventDefault();
  flap();
});
byId("leave").onclick = () => {
  const previous = socket;
  socket = null;
  connected = false;
  clearTimeout(retry);
  previous?.close();
  localStorage.removeItem("spp4-flight");
  token = null;
  name = "";
  board = "";
  byId("game").hidden = true;
  byId("entry").hidden = false;
  byId("status").textContent = "";
};
if (token) connect();
