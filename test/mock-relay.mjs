import { WebSocketServer } from 'ws';

export function startMockRelay() {
  return new Promise((resolve) => {
    const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' }, () => {
      const subscriptions = new Map();
      const events = [];
      const frames = [];
      const matches = (filter, event) => (!filter.kinds || filter.kinds.includes(event.kind))
        && (!filter['#x'] || event.tags.some((tag) => tag[0] === 'x' && filter['#x'].includes(tag[1])));
      const send = (socket, message) => {
        const text = JSON.stringify(message);
        frames.push(text);
        if (socket.readyState === 1) socket.send(text);
      };

      wss.on('connection', (socket) => {
        subscriptions.set(socket, new Map());
        socket.on('message', (raw) => {
          const text = raw.toString();
          frames.push(text);
          let message;
          try { message = JSON.parse(text); } catch { return; }
          if (message[0] === 'REQ') {
            const [, id, ...filters] = message;
            subscriptions.get(socket).set(id, filters);
            for (const event of events) {
              if (filters.some((filter) => matches(filter, event))) send(socket, ['EVENT', id, event]);
            }
            send(socket, ['EOSE', id]);
          } else if (message[0] === 'CLOSE') {
            subscriptions.get(socket).delete(message[1]);
          } else if (message[0] === 'EVENT') {
            const event = message[1];
            send(socket, ['OK', event.id, true, '']);
            events.push(event);
            if (events.length > 500) events.shift();
            for (const [other, entries] of subscriptions) {
              for (const [id, filters] of entries) {
                if (filters.some((filter) => matches(filter, event))) send(other, ['EVENT', id, event]);
              }
            }
          }
        });
        socket.on('close', () => subscriptions.delete(socket));
      });
      resolve({
        url: `ws://127.0.0.1:${wss.address().port}`,
        frames,
        close: () => new Promise((done) => wss.close(done)),
      });
    });
  });
}
