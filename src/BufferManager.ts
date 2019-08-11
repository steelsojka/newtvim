import * as vscode from 'vscode';
import {
  merge,
  Observable,
  from,
  throwError,
  of,
  ConnectableObservable,
  Subscription,
  BehaviorSubject
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

export class BufferEntry extends Subscription {
  private isUpdatingVsCode: boolean = false;
  private isUpdatingNeovim: boolean = false;
  private _isUpdatingVsCode$ = new BehaviorSubject<boolean>(false);
  private _isUpdatingNeovim$ = new BehaviorSubject<boolean>(false);
  private readonly onSelectionChange$ = fromVsCodeEvent(
    vscode.window.onDidChangeTextEditorSelection
  ).pipe(
    filter(
      event =>
        event.payload.textEditor.document.uri.toString() ===
        this.document.uri.toString()
    ),
    map(event => event.payload)
  );

  public readonly isUpdatingVsCode$ = this._isUpdatingVsCode$.asObservable();
  public readonly isUpdatingNeovim$ = this._isUpdatingNeovim$.asObservable();

  constructor(
    public readonly buffer: Buffer,
    public readonly document: vscode.TextDocument,
    public readonly client: NeovimClient
  ) {
    super();

    this.isUpdatingNeovim$.subscribe(value => (this.isUpdatingNeovim = value));
    this.isUpdatingVsCode$.subscribe(value => (this.isUpdatingVsCode = value));
    this.buffer.name = this.document.uri.toString();

    this.add(() => {
      this._isUpdatingNeovim$.complete();
      this._isUpdatingVsCode$.complete();
    });

    this.add(
      this.buffer.listen(
        'lines',
        (_buffer, tick, startLine, endLine, content) => {
          if (
            vscode.window.activeTextEditor &&
            vscode.window.activeTextEditor.document.uri.toString() ===
              this.document.uri.toString()
          ) {
            this.syncTextToVsCode(
              startLine,
              endLine,
              content,
              vscode.window.activeTextEditor
            );
          }
        }
      )
    );

    this.add(
      fromVsCodeEvent(vscode.workspace.onDidChangeTextDocument)
        .pipe(
          filter(
            event =>
              event.payload.document.uri.toString() ===
              this.document.uri.toString()
          )
        )
        .subscribe(event => this.syncTextToNeovim(event.payload))
    );

    this.onSelectionChange$.subscribe(event =>
      this.syncSelectionToNeovim(event)
    );
  }

  public async syncSelectionToNeovim(
    event: vscode.TextEditorSelectionChangeEvent
  ): Promise<void> {
    console.log('selection', event);
    this.syncToNeovim(async () => {
      for (const selection of event.selections) {
        if (selection.isEmpty) {
          await this.client.command(
            `call cursor(${selection.start.line + 1}, ${selection.start
              .character + 1})`
          );
        } else {
        }
      }
    });
  }

  public async syncTextToNeovim(
    event: vscode.TextDocumentChangeEvent
  ): Promise<void> {
    console.log('vscode -> nvim: start');
    await this.syncToNeovim(async () => {
      const document = event.document;

      for (const change of event.contentChanges) {
        const startLine = change.range.start.line;
        const endLine = change.range.end.line;
        const lineCount = document.lineCount;
        let lines = [] as string[];

        for (let i = startLine; i <= endLine; i++) {
          const content = i >= lineCount ? '' : document.lineAt(i).text;

          lines.push(content);
        }

        await this.buffer.replace(lines, startLine);
        console.log('vscode -> nvim: updated');
      }
    });
    console.log('vscode -> nvim: end');
  }

  public async syncTextToVsCode(
    startLine: number,
    endLine: number,
    content: string[],
    textEditor: vscode.TextEditor
  ): Promise<void> {
    console.log('nvim -> vscode: start');

    await this.syncToVscode(async () => {
      await textEditor.edit(builder => {
        let contentIndex = 0;
        const editor = this.document;
        const lineCount = this.document.lineCount;

        for (let i = startLine; i < endLine; i++) {
          const line = i >= lineCount ? null : editor.lineAt(i);
          const lineContent = content[contentIndex++];

          if (line) {
            if (lineContent !== undefined) {
              builder.replace(
                line.rangeIncludingLineBreak,
                contentIndex >= content.length
                  ? lineContent
                  : `${lineContent}\n`
              );
            } else {
              builder.delete(line.rangeIncludingLineBreak);
            }
          } else {
            const range = new vscode.Range(
              new vscode.Position(i, 0),
              new vscode.Position(i, Number.MAX_SAFE_INTEGER)
            );

            builder.insert(range.start, lineContent);
          }
        }

        console.log('nvim -> vscode: updated');
        return Promise.resolve(true);
      });
    });
    console.log('nvim -> vscode: end');
  }

  private async syncToVscode(
    fn: (...args: any[]) => Promise<void>
  ): Promise<void> {
    if (this.isUpdatingNeovim) {
      return;
    }

    this._isUpdatingVsCode$.next(true);
    await fn();
    this._isUpdatingVsCode$.next(false);
  }

  private async syncToNeovim(
    fn: (...args: any[]) => Promise<void>
  ): Promise<void> {
    if (this.isUpdatingVsCode) {
      return;
    }

    this._isUpdatingNeovim$.next(true);
    await fn();
    this._isUpdatingNeovim$.next(false);
  }
}

export class BufferManager extends Disposable {
  private readonly _onDidInitialize = new vscode.EventEmitter<
    vscode.TextDocument[]
  >();
  public readonly onDidInitialize = this._onDidInitialize.event;
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

              entry$.subscribe(entry => entry.unsubscribe());

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
    const entrySource$ = from(client.createBuffer(true, false)).pipe(
      mergeMap(buffer =>
        buffer === 0
          ? throwError(new Error('Could not create buffer.'))
          : of(buffer as Buffer)
      ),
      map(buffer => {
        const entry = new BufferEntry(buffer, document, client);

        entry.add(async () =>
          client.command(`bdelete! ${await entry.buffer.name}`)
        );

        return entry;
      }),
      publishReplay(1)
    ) as ConnectableObservable<BufferEntry>;

    entrySource$.connect();

    return entrySource$;
  }
}
