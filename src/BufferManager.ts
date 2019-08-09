import * as vscode from 'vscode';
import {
  merge,
  Observable,
  from,
  throwError,
  of,
  Subject,
  ConnectableObservable
} from 'rxjs';
import { NeovimClient, Buffer } from 'neovim';
import {
  scan,
  shareReplay,
  withLatestFrom,
  mergeMap,
  map,
  startWith,
  publishReplay,
  tap
} from 'rxjs/operators';

import { Disposable } from './Disposable';
import { fromVsCodeEvent } from './utils';

export class BufferEntry extends vscode.Disposable {
  constructor(public readonly buffer: Buffer, dispose: Function) {
    super(() => dispose());
  }
}

export class BufferManager extends Disposable {
  private _linesChanged$ = new Subject<{
    document: vscode.TextDocument;
    buffer: Buffer;
    tick: number;
    startLine: number;
    endLine: number;
    content: string[];
  }>();

  public readonly linesChanged$ = this._linesChanged$.asObservable();

  public readonly buffers$ = merge(
    fromVsCodeEvent(vscode.workspace.onDidOpenTextDocument),
    fromVsCodeEvent(vscode.workspace.onDidCloseTextDocument)
  ).pipe(
    withLatestFrom(this.client$),
    scan(
      (state, [event, client]) => {
        switch (event.type) {
          case vscode.workspace.onDidOpenTextDocument: {
            const id = event.payload.uri.toString();

            if (!state[id]) {
              return {
                ...state,
                [id]: this.setupBuffer(client, event.payload)
              };
            }

            return state;
          }
          case vscode.workspace.onDidCloseTextDocument: {
            const id = event.payload.uri.toString();

            if (state[id]) {
              const entry$ = state[id];
              const newState = { ...state };

              delete newState[id];

              entry$.subscribe(entry => entry.dispose());

              return newState;
            }

            return state;
          }
          default:
            return state;
        }
      },
      {} as { [key: string]: Observable<BufferEntry> }
    ),
    startWith({}),
    shareReplay(1)
  );

  constructor(private client$: Observable<NeovimClient>) {
    super();

    this.buffers$.subscribe(console.log);
    this._linesChanged$.subscribe(console.log);
  }

  private setupBuffer(
    client: NeovimClient,
    document: vscode.TextDocument
  ): Observable<BufferEntry> {
    const entrySource$ = from(client.createBuffer(true, false)).pipe(
      mergeMap(buffer =>
        buffer === 0
          ? throwError(new Error('Could not create buffer.'))
          : of(buffer as Buffer)
      ),
      map(buffer => {
        const sub = buffer.listen(
          'lines',
          (_buffer, tick, startLine, endLine, content) =>
            this._linesChanged$.next({
              startLine,
              endLine,
              tick,
              content,
              document,
              buffer: _buffer
            })
        );

        buffer.name = document.uri.toString();

        return new BufferEntry(buffer, async () => {
          sub();
          // Delete buffer from neovim.
          client.command(`bdelete! ${await buffer.name}`);
        });
      }),
      publishReplay(1)
    ) as ConnectableObservable<BufferEntry>;

    entrySource$.connect();

    return entrySource$;
  }
}
