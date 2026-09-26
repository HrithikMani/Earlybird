/**
 * Turns a Fastify reply into a Server-Sent Events stream.
 * Returns { send(event, data), onClose(fn) }.
 */
export function openSse(request, reply) {
  reply.hijack();
  const res = reply.raw;
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(': connected\n\n');
  const closers = [];
  let closed = false;
  const ping = setInterval(() => !closed && res.write(': ping\n\n'), 15000);
  request.raw.on('close', () => {
    closed = true;
    clearInterval(ping);
    for (const fn of closers) {
      try {
        fn();
      } catch {
        // ignore
      }
    }
  });
  return {
    send(event, data) {
      if (!closed) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    },
    onClose(fn) {
      closers.push(fn);
    },
    get closed() {
      return closed;
    },
  };
}
