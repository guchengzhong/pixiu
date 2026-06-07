export function withSignal(init: RequestInit = {}, signal?: AbortSignal): RequestInit {
  return signal ? { ...init, signal } : init
}
