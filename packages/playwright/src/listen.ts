import net from 'node:net'

/**
 * Reports every TCP port a server in this process listens on. Servers of the run are told apart by
 * the ports they listen on: traffic to a local port no observed process listened on reached a
 * server Veyrum did not observe.
 */
export function observeListening(record: (port: number) => void): void {
  const proto = net.Server.prototype
  const listen = proto.listen
  proto.listen = function (this: net.Server, ...args: unknown[]) {
    try {
      this.once('listening', () => {
        try {
          const address = this.address()
          if (address && typeof address === 'object') record(address.port)
        } catch {
          // Observation must never change behavior.
        }
      })
    } catch {
      // Observation must never change behavior.
    }
    return (listen as (...a: unknown[]) => net.Server).apply(this, args)
  } as typeof proto.listen
}
