import * as vscode from 'vscode';
import {
  merge,
  Observable,
  from,
  throwError,
  of,
  Subject,
  ConnectableObservable,
  Subscription
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
  tap,
  takeUntil,
  share,
  filter
} from 'rxjs/operators';

import { Disposable } from './Disposable';
import { fromVsCodeEvent, InferEventArgs } from './utils';

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

  private readonly _vsDocumentChanged$ = new Subject<{
    document: vscode.TextDocument;
    buffer: Buffer;
    readonly contentChanges: vscode.TextDocumentContentChangeEvent[];
  }>();

  private readonly _onDidInitialize = new vscode.EventEmitter<
    vscode.TextDocument[]
  >();
  public readonly onDidInitialize = this._onDidInitialize.event;
  public readonly linesChanged$ = this._linesChanged$.asObservable();
  public readonly vsDocumentChanged$ = this._vsDocumentChanged$.asObservable();
  public readonly buffers$ = merge(
    fromVsCodeEvent(vscode.workspace.onDidOpenTextDocument),
    fromVsCodeEvent(vscode.workspace.onDidCloseTextDocument),
    fromVsCodeEvent(this.onDidInitialize)
  ).pipe(
    withLatestFrom(this.client$),
    scan(
      (state, [event, client]) => {
        switch (event.type) {
          case this.onDidInitialize: {
            return (event.payload as InferEventArgs<
              this['onDidInitialize']
            >).reduce((acc, textEditor) => {
              const id = textEditor.uri.toString();

              if (!state[id]) {
                return {
                  ...acc,
                  [id]: this.setupBuffer(client, textEditor)
                };
              }

              return acc;
            }, state);
          }
          case vscode.workspace.onDidOpenTextDocument: {
            const payload = event.payload as InferEventArgs<
              typeof vscode.workspace.onDidOpenTextDocument
            >;
            const id = payload.uri.toString();

            if (!state[id]) {
              return {
                ...state,
                [id]: this.setupBuffer(client, payload)
              };
            }

            return state;
          }
          case vscode.workspace.onDidCloseTextDocument: {
            const payload = event.payload as InferEventArgs<
              typeof vscode.workspace.onDidCloseTextDocument
            >;
            const id = payload.uri.toString();

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

  private documentChanged$ = fromVsCodeEvent(
    vscode.workspace.onDidChangeTextDocument
  ).pipe(
    takeUntil(this.disposed$),
    share()
  );

  constructor(private client$: Observable<NeovimClient>) {
    super();

    // this.buffers$.subscribe(console.log);
    // this._linesChanged$.subscribe(console.log);

    this.client$.subscribe(() => {
      this._onDidInitialize.fire(vscode.workspace.textDocuments);
    });
  }

  private setupBuffer(
    client: NeovimClient,
    document: vscode.TextDocument
  ): Observable<BufferEntry> {
    const documentUri = document.uri.toString();
    const entrySource$ = from(client.createBuffer(true, false)).pipe(
      mergeMap(buffer =>
        buffer === 0
          ? throwError(new Error('Could not create buffer.'))
          : of(buffer as Buffer)
      ),
      map(buffer => {
        const sub = new Subscription();

        sub.add(
          buffer.listen('lines', (_buffer, tick, startLine, endLine, content) =>
            this._linesChanged$.next({
              startLine,
              endLine,
              tick,
              content,
              document,
              buffer: _buffer
            })
          )
        );

        buffer.name = documentUri;

        this.documentChanged$
          .pipe(
            filter(
              event => event.payload.document.uri.toString() === documentUri
            )
          )
          .subscribe(event =>
            this._vsDocumentChanged$.next({
              buffer,
              document: event.payload.document,
              contentChanges: event.payload.contentChanges as any
            })
          );

        return new BufferEntry(buffer, async () => {
          sub.unsubscribe();
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
