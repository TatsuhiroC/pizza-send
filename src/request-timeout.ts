// AbortSignal.timeout is missing in some otherwise capable mobile browsers.
// Keep the deadline and caller cancellation without requiring that newer API.
export async function fetchWithTimeout<T = Response>(input: RequestInfo | URL, options: RequestInit = {}, milliseconds = 10000, consume?: (response: Response) => Promise<T>): Promise<T> {
  const controller = new AbortController(), source = options.signal;
  let abortReason: unknown;
  const abort = (reason: unknown) => {
    if (!controller.signal.aborted) { abortReason = reason; controller.abort(reason); }
  };
  const cancel = () => abort(source?.reason ?? new DOMException('Cancelled', 'AbortError'));
  if (source?.aborted) cancel();
  else source?.addEventListener('abort', cancel, { once: true });
  const timer = setTimeout(() => abort(new DOMException('Request timed out', 'TimeoutError')), milliseconds);
  try {
    const response = await fetch(input, { ...options, signal: controller.signal });
    // JSON consumers stay inside the deadline, including a stalled body after
    // the HTTP headers have arrived. Header-only callers may omit consume.
    return consume ? await consume(response) : response as T;
  } catch (error) { throw controller.signal.aborted ? abortReason : error; }
  finally { clearTimeout(timer); source?.removeEventListener('abort', cancel); }
}
