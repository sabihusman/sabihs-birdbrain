import type { FetchLike } from '../src/providers/ollama.js';
import { pickScenario, recordedResponse } from './fake-gemini.js';

/**
 * Ollama Cloud failure scenarios, chosen from a `[ollama:<name>]` tag in the
 * QUESTION line; without one the shared fixture scenarios from fake-gemini
 * apply, so the adversarial suite runs the same replies through both providers.
 */
export type OllamaScenario = 'rate_limit' | 'queue_full' | 'server' | 'bad_gateway' | 'timeout' | 'empty' | 'length' | 'auth' | 'not_json' | 'network';

export interface RecordedCall {
  url: string;
  headers: Record<string, string>;
  body: {
    model: string;
    messages: Array<{ role: string; content: string }>;
    stream: boolean;
    options?: { temperature?: number; num_predict?: number };
  };
}

const jsonResponse = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** A complete reply in the documented shape (docs.ollama.com/api/chat, 2026-10-19). */
export function ollamaReply(content: string, doneReason = 'stop', model = 'fake-model'): Record<string, unknown> {
  return { model, created_at: '2026-10-19T12:00:00Z', message: { role: 'assistant', content }, done: true, done_reason: doneReason, total_duration: 1_200_000_000, prompt_eval_count: 1700, eval_count: doneReason === 'stop' ? 110 : 1400 };
}

export function pickOllamaScenario(question: string): OllamaScenario | undefined {
  const m = /\[ollama:([a-z_]+)\]/.exec(question.toLowerCase());
  return m ? (m[1] as OllamaScenario) : undefined;
}

/** Stand-in for `fetch` against https://ollama.com/api/chat: records every call, answers from the fixtures. */
export class FakeOllama {
  readonly calls: RecordedCall[] = [];
  /** Forces one scenario regardless of the question (chain tests). */
  force?: OllamaScenario;
  /** Ignore the shared `[scenario:…]` tags and always answer (chain tests where only Gemini should misbehave). */
  answerOnly = false;
  readonly fetch: FetchLike = (url, init) => {
    const body = JSON.parse(init.body) as RecordedCall['body'];
    this.calls.push({ url, headers: init.headers, body });
    const user = body.messages.find((m) => m.role === 'user')?.content ?? '';
    const scenario = this.force ?? pickOllamaScenario(user);
    switch (scenario) {
      case 'rate_limit':
        return Promise.resolve(jsonResponse({ error: 'usage limit reached' }, 429));
      case 'queue_full':
        return Promise.resolve(jsonResponse({ error: 'queue is full, try again later' }, 429));
      case 'server':
        return Promise.resolve(jsonResponse({ error: 'internal server error' }, 500));
      case 'bad_gateway':
        return Promise.resolve(jsonResponse({ error: 'cloud model cannot be reached' }, 502));
      case 'auth':
        return Promise.resolve(jsonResponse({ error: 'unauthorized' }, 401));
      case 'not_json':
        return Promise.resolve(new Response('<html>bad gateway</html>', { status: 502 }));
      case 'network':
        return Promise.reject(new TypeError('fetch failed'));
      case 'timeout':
        // Never resolves on its own; rejects the way undici does when the signal fires.
        return new Promise<Response>((_, reject) => {
          init.signal.addEventListener('abort', () => reject(Object.assign(new Error('This operation was aborted'), { name: 'AbortError' })), { once: true });
        });
      case 'empty':
        return Promise.resolve(jsonResponse(ollamaReply('')));
      case 'length':
        return Promise.resolve(jsonResponse(ollamaReply('The Wikipedia article does not mention Des Moines, though it notes that the species breeds across the northern forests. [Range] It winters in open country with scattered trees, and the', 'length')));
      default: {
        const shared = this.answerOnly ? 'answer' : pickScenario(user);
        try {
          return Promise.resolve(jsonResponse(ollamaReply(recordedResponse(shared))));
        } catch {
          return Promise.resolve(jsonResponse({ error: 'the model failed to generate a response' }, 500));
        }
      }
    }
  };
  get last(): RecordedCall {
    const c = this.calls.at(-1);
    if (!c) throw new Error('no Ollama call recorded');
    return c;
  }
}
