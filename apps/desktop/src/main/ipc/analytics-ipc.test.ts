import { expect, test } from "bun:test";
import { resolve } from "node:path";

test("privacy IPC is local-only, rejects child/unowned frames and broadcasts sanitized state only to app documents", () => {
  const result = Bun.spawnSync(
    [
      process.execPath,
      "--no-env-file",
      "--eval",
      `
    import {mock,expect} from 'bun:test';
    const handlers=new Map(),messages=[];
    const entry='tidy://app/index.html';
    const makeWindow=(url,destroyed=false)=>({isDestroyed:()=>destroyed,webContents:{mainFrame:{url},send:(channel,state)=>messages.push({url,channel,state})}});
    const trusted=makeWindow(entry),foreign=makeWindow('https://evil.example/'),destroyed=makeWindow(entry,true);
    mock.module('electron',()=>({BrowserWindow:{getAllWindows:()=>[trusted,foreign,destroyed],fromWebContents:sender=>sender===trusted.webContents?trusted:undefined},ipcMain:{handle:(key,fn)=>handlers.set(key,fn)},dialog:{},shell:{}}));
    const {registerAnalyticsIPC}=await import('./src/main/ipc/ipc');
    const state={usage:false,diagnostics:false,linked:false,available:true,pendingDeletion:false,expiresAt:null,notice:'2026-10-26.desktop-analytics-1'};
    let emit,reads=0;
    registerAnalyticsIPC({subscribe:fn=>{emit=fn;return()=>{}},state:async()=>{reads++;return state},refresh:()=>{throw new Error('Local reads must not refresh the network')},choose:async choices=>({...state,...choices})},entry);
    const invoke=handlers.get('tidy:analytics');
    const event={sender:trusted.webContents,senderFrame:trusted.webContents.mainFrame};
    expect(await invoke(event,'state')).toEqual(state);expect(reads).toBe(1);
    await expect(invoke({...event,senderFrame:{url:entry}},'state')).rejects.toThrow('Untrusted');
    await expect(invoke({...event,sender:foreign.webContents},'state')).rejects.toThrow('Untrusted');
    await expect(invoke(event,'choose',{usage:true,diagnostics:false,token:'SECRET-CANARY'})).rejects.toThrow();
    await expect(invoke(event,'capture',{name:'arbitrary-event'})).rejects.toThrow();
    emit(state);
    expect(messages).toEqual([{url:entry,channel:'tidy:privacy-state',state}]);
    expect(JSON.stringify(messages)).not.toContain('SECRET');
    console.log('PASS');
  `,
    ],
    {
      cwd: resolve(import.meta.dir, "../../.."),
      env: { ...process.env, NODE_ENV: "test" },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  expect(result.exitCode, result.stderr.toString()).toBe(0);
  expect(result.stdout.toString()).toContain("PASS");
});
