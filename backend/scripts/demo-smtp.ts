import { SMTPServer } from 'smtp-server';
import { mkdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

// Local SMTP capture: real SMTP delivery, no external recipient forwarding.
const server = new SMTPServer({
  secure: false,
  disabledCommands: ['STARTTLS'],
  onAuth(auth, _session, callback) {
    callback(
      auth.username === 'demo' && auth.password === 'demo'
        ? null
        : new Error('Invalid local credentials'),
      { user: 'demo' },
    );
  },
  onData(stream, _session, callback) {
    const chunks: Buffer[] = [];
    stream.on('data', (chunk) => chunks.push(chunk));
    stream.on('end', () => {
      void mkdir('.demo-data/mail', { recursive: true })
        .then(() =>
          writeFile(`.demo-data/mail/${Date.now()}-${randomUUID()}.eml`, Buffer.concat(chunks)),
        )
        .then(
          () => callback(),
          (err) => callback(err),
        );
    });
  },
});
server.listen(2525, '127.0.0.1', () =>
  console.log('Local SMTP capture listening on 127.0.0.1:2525'),
);
