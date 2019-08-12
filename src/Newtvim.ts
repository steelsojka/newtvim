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
  Subscription,
  of
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
  tap,
  pairwise
} from 'rxjs/operators';
import { attach, NeovimClient, Buffer } from 'neovim';
import { spawn, ChildProcess } from 'child_process';
import { fromVsCodeCommand, fromVsCodeEvent, InferEventArgs } from './utils';
import { BufferManager, BufferEntry } from './BufferManager';
import { Screen, VimMode } from './Screen';
import { RSA_X931_PADDING } from 'constants';

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

  private readonly activeBufferEntry$ = this.activeTextEditor$.pipe(
    switchMap(editor =>
      editor
        ? this.buffersManager.waitUntilBufferExists(
            editor!.document.uri.toString()
          )
        : of(null)
    ),
    tap(v => console.log('v', v)),
    shareReplay(1)
  );

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
      .pipe(
        withLatestFrom(this.activeTextEditor$, this.screen.mode$),
        filter(([, , mode]) => mode !== VimMode.INSERT)
      )
      .subscribe(
        ([pos, editor]) =>
          (editor!.selection = new vscode.Selection(
            new vscode.Position(pos.y, pos.x),
            new vscode.Position(pos.y, pos.x)
          ))
      );

    // When the active text editor changes, wait for the buffer to be created is it doesn't exist already.
    // Then make the active buffer in neovim the same as vscodes.
    this.activeBufferEntry$
      .pipe(
        filter(value => Boolean(value)),
        withLatestFrom(this.client$)
      )
      .subscribe(([entry, client]) => {
        if (entry) {
          client.command(`b! ${entry.buffer.id}`);
        }
      });

    this.screen.mode$
      .pipe(
        pairwise(),
        filter(
          ([prev, next]) => prev === VimMode.INSERT && next !== VimMode.INSERT
        ),
        withLatestFrom(this.activeBufferEntry$)
      )
      .subscribe(async ([, entry]) => {
        if (entry) {
          const lines = await entry.buffer.lines;

          await entry.buffer.setLines(entry.document.getText().split('\n'), {
            start: 0,
            end: lines.length,
            strictIndexing: false
          });
        }
      });

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
}
