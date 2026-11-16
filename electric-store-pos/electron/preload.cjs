'use strict';
const {contextBridge,ipcRenderer}=require('electron');
contextBridge.exposeInMainWorld('shop',{invoke:(action,data)=>ipcRenderer.invoke('shop:invoke',action,data||{})});
