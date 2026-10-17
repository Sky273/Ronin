export {};
// Processus enfant de tests/deploy.test.ts : le vrai serveur (server/index.ts), arrêté par un SIGTERM simulé.
// Sous Windows, child.kill('SIGTERM') tue sans signal : le parent envoie 'term' par le canal IPC, et l'enfant
// émet lui-même SIGTERM (mêmes gestionnaires que sous Linux, dans Docker).
process.on('message', (m) => {
  if (m === 'term') process.emit('SIGTERM');
});
await import('../../server/index');
