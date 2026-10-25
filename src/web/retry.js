function intent(payload) {
  const command = JSON.parse(payload);
  return JSON.stringify(Object.keys(command).filter(key => key !== 'version').sort().map(key => [key, command[key]]));
}

/** Recover an uncertain write before allowing another write on the same endpoint. */
export function prepareWrite(cached, command, makeKey) {
  const payload = JSON.stringify(command);
  if (cached && typeof cached.payload === 'string' && typeof cached.key === 'string') {
    try {
      return { pending: cached, recoveryOnly: intent(cached.payload) !== intent(payload) };
    } catch { /* Ignore corrupt browser storage; normal validation still applies on the server. */ }
  }
  return { pending: { payload, key: makeKey() }, recoveryOnly: false };
}
