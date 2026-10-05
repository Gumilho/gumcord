// Front proxy for the e2e stack: /rtc goes to LiveKit, everything else to the backend, like the real reverse proxy.
import http from "node:http";
import net from "node:net";
const BACKEND = 18080, LIVEKIT = 7890, PORT = 18090;
const target = (url) => (url.startsWith("/rtc") ? LIVEKIT : BACKEND);
const server = http.createServer((req, res) => {
  const p = http.request({ port: target(req.url), host: "127.0.0.1", path: req.url, method: req.method, headers: req.headers }, (r) => {
    res.writeHead(r.statusCode, r.headers); r.pipe(res);
  });
  p.on("error", () => { res.statusCode = 502; res.end(); });
  req.pipe(p);
});
server.on("upgrade", (req, socket, head) => {
  const up = net.connect(target(req.url), "127.0.0.1", () => {
    up.write(`${req.method} ${req.url} HTTP/1.1\r\n` + Object.entries(req.headers).map(([k, v]) => `${k}: ${v}`).join("\r\n") + "\r\n\r\n");
    up.write(head); socket.pipe(up); up.pipe(socket);
  });
  up.on("error", () => socket.destroy()); socket.on("error", () => up.destroy());
});
server.listen(PORT, "127.0.0.1", () => console.log("proxy on", PORT));
