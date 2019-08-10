import * as vscode from 'vscode';
import {
  Subject,
  combineLatest,
  BehaviorSubject,
  Observable,
  ReplaySubject,
  defer,
  merge,
  Subscriber,
  Subscription
} from 'rxjs';
import {
  startWith,
  share,
  takeUntil,
  withLatestFrom,
  switchMap,
  shareReplay,
  mapTo,
  take,
  map,
  filter,
  mergeMap,
  tap
} from 'rxjs/operators';
import { attach, NeovimClient, Buffer } from 'neovim';
import { spawn, ChildProcess } from 'child_process';
import { fromVsCodeCommand, fromVsCodeEvent, InferEventArgs } from './utils';
import { BufferManager, BufferEntry } from './BufferManager';
import { Screen, VimMode } from './Screen';

export class Newtvim extends vscode.Disposable {
  private _client$ = new ReplaySubject<NeovimClient>(1);
  private client$ = this._client$.asObservable();
  private process!: ChildProcess;
  private disposed$ = new Subject<void>();
  private type$ = fromVsCodeCommand<{ text: string }>('type').pipe(
    takeUntil(this.disposed$),
    share()
  );

  private insertModeKeyFeed$ = this.type$.pipe(
    withLatestFrom(defer(() => this.screen.mode$)),
    filter(([, mode]) => mode === VimMode.INSERT),
    map(([arg]) => arg),
    share()
  );

  private neovimKeyFeed$ = this.type$.pipe(
    withLatestFrom(defer(() => this.screen.mode$)),
    filter(([, mode]) => mode !== VimMode.INSERT),
    map(([arg]) => arg),
    share()
  );

  private activeTextEditor$ = fromVsCodeEvent(
    vscode.window.onDidChangeActiveTextEditor
  ).pipe(
    map(event => event.payload),
    startWith(vscode.window.activeTextEditor),
    shareReplay(1)
  );

  private notifications$ = this.client$
    .pipe(
      switchMap(
        client =>
          new Observable<[string, any[]]>(subscriber => {
            const handler = (event, data) => subscriber.next([event, data]);

            client.on('notification', handler);

            return () => client.off('notification', handler);
          })
      )
    )
    .pipe(share());

  private client!: NeovimClient;
  private buffersManager = new BufferManager(this.client$);
  private screen = new Screen();

  constructor(private neovimPath: string) {
    super(() => {});

    this.client$.subscribe(client => (this.client = client));

    this.neovimKeyFeed$
      .pipe(withLatestFrom(this.client$))
      .subscribe(([arg, client]) => client.feedKeys(arg.text, 't', true));

    this.insertModeKeyFeed$.subscribe(arg =>
      vscode.commands.executeCommand('default:type', arg)
    );

    this.screen.cursorPosition$
      .pipe(withLatestFrom(this.activeTextEditor$))
      .subscribe(
        ([pos, editor]) =>
          (editor!.selection = new vscode.Selection(
            new vscode.Position(pos.y, pos.x),
            new vscode.Position(pos.y, pos.x)
          ))
      );

    this.buffersManager.linesChanged$.subscribe(event => {
      this.handleBufferLineEvent(event.startLine, event.endLine, event.content);
    });

    this.buffersManager.vsDocumentChanged$.subscribe(event => {
      this.handleVsDocumentChange(
        event.buffer,
        event.document,
        event.contentChanges
      );
    });

    // When the active text editor changes, wait for the buffer to be created is it doesn't exist already.
    // Then make the active buffer in neovim the same as vscodes.
    this.activeTextEditor$
      .pipe(
        filter(maybeEditor => Boolean(maybeEditor)),
        switchMap(editor =>
          this.buffersManager.buffers$.pipe(
            filter<{ [key: string]: Observable<BufferEntry> }>(buffers =>
              buffers.hasOwnProperty(editor!.document.uri.toString())
            ),
            mergeMap(buffers => buffers[editor!.document.uri.toString()]),
            take(1)
          )
        ),
        withLatestFrom(this.client$)
      )
      .subscribe(([entry, client]) => client.command(`b! ${entry.buffer.id}`));

    this.notifications$
      .pipe(filter(event => event[0] === 'redraw'))
      .subscribe(event => this.screen.redraw(event[1]));
  }

  async start(): Promise<void> {
    // this.process = spawn(this.neovimPath, ['-n', '--embed']);
    // this.process.on('error', err => console.log(err.message));

    // const client = attach({ proc: this.process });
    const client = attach({ socket: '/tmp/nvim' });

    await client.uiAttach(250, 250, {
      ext_popupmenu: true,
      ext_cmdline: true,
      rgb: false
    });

    this._client$.next(client);

    // this.client.setOption('hidden', false);
  }

  dispose(): void {
    this.disposed$.next();
    this.disposed$.complete();
  }

  private async handleBufferLineEvent(
    startLine: number,
    endLine: number,
    content: string[]
  ): Promise<void> {
    await vscode.window.activeTextEditor!.edit(builder => {
      let contentIndex = 0;
      const editor = vscode.window.activeTextEditor!.document;
      const lineCount = vscode.window.activeTextEditor!.document.lineCount;

      for (let i = startLine; i < endLine; i++) {
        const line = i >= lineCount ? null : editor.lineAt(i);
        const lineContent = content[contentIndex++];

        if (line) {
          if (lineContent !== undefined) {
            builder.replace(
              line.rangeIncludingLineBreak,
              contentIndex >= content.length ? lineContent : `${lineContent}\n`
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

      return Promise.resolve(true);
    });
  }

  private async handleVsDocumentChange(
    buffer: Buffer,
    document: vscode.TextDocument,
    changes: vscode.TextDocumentContentChangeEvent[]
  ): Promise<void> {
    for (const change of changes) {
      const bufferLines = await buffer.lines;
      const startLine = change.range.start.line;
      const endLine = change.range.end.line;
      const lineCount = document.lineCount;
      let lines = [] as string[];
      let hasChanged = false;

      for (let i = startLine; i <= endLine; i++) {
        const content = i >= lineCount ? '' : document.lineAt(i).text;

        hasChanged = hasChanged || bufferLines[i] !== content;
        lines.push(content);
      }

      if (hasChanged) {
        buffer.replace(lines, startLine);
      }

      console.log(hasChanged);
    }
  }
}
