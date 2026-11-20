export function liveConnectionOptions() {
  return {
    autoConnect: false,
    forceNew: true,
    transports: ['websocket', 'polling'],
    tryAllTransports: true,
    timeout: 10_000,
    reconnectionDelay: 2000 + Math.floor(Math.random() * 1500),
    reconnectionDelayMax: 7500 + Math.floor(Math.random() * 2500),
    randomizationFactor: 0.5,
  };
}
