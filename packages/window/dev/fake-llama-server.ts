// A stand-in for llama-server in the window preview: ghostd spawns it as `local.server`, and it answers every
// chat with one short reply that names its file, so Ask can be checked without loading a model.
const args = process.argv.slice(2);
const port = Number(args[args.indexOf("--port") + 1]);
const reply = "The boat leaves at **nine**, from the north pier (Documents/Notes/Ferry trip.md).\n\n- Bring the tickets.\n- Sara is meeting you there.";

Bun.serve({
  port,
  hostname: "127.0.0.1",
  async fetch(request) {
    const { pathname } = new URL(request.url);
    if (pathname === "/health") return new Response("ok");
    if (pathname !== "/v1/chat/completions") return new Response("not found", { status: 404 });
    const words = reply.split(/(?<= )/u);
    const stream = new ReadableStream({
      async start(controller) {
        for (const word of words) {
          controller.enqueue(`data: ${JSON.stringify({ choices: [{ delta: { content: word } }] })}\n\n`);
          await Bun.sleep(20);
        }
        controller.enqueue("data: [DONE]\n\n");
        controller.close();
      },
    });
    return new Response(stream, { headers: { "Content-Type": "text/event-stream" } });
  },
});
