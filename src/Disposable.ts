import * as vscode from 'vscode';
import { Subject } from 'rxjs';

export class Disposable extends vscode.Disposable {
  private _disposed$ = new Subject<void>();
  public disposed$ = this._disposed$.asObservable();

  constructor() {
    super(() => {});
  }

  public dispose(): void {
    this._disposed$.next();
    this._disposed$.complete();
  }
}
