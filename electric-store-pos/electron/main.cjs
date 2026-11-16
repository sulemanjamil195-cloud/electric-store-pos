'use strict';
const {app,BrowserWindow,ipcMain,dialog,shell}=require('electron');
const fs=require('node:fs');const path=require('node:path');
const {openDb,integrity}=require('./db.cjs');
const {ShopService}=require('./service.cjs');
let win,db,service,backupTimer,busyBackup=false,exitBackupDone=false,skipExitBackup=false;
const dataDir=()=>app.getPath('userData');
const backupDir=()=>path.join(dataDir(),'backups');
const safeName=x=>String(x||'').replace(/[&<>"']/g,k=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[k]));
const money=n=>'Rs '+(n/100).toLocaleString('en-PK',{minimumFractionDigits:2,maximumFractionDigits:2});
async function makeBackup(reason='manual'){
 if(busyBackup)throw Error('A backup is already running');busyBackup=true;
 const stamp=new Date().toISOString().replace(/[:.]/g,'-');
 const dir=backupDir();fs.mkdirSync(dir,{recursive:true});const dest=path.join(dir,`store-${stamp}.db`),tmp=dest+'.tmp';
 try{
  if(db.__driver==='better')await db.backup(tmp);
  else await require('node:sqlite').backup(db,tmp);
  const test=openDb(tmp);const good=integrity(test);test.close();if(!good)throw Error('Backup integrity check failed');
  fs.renameSync(tmp,dest);
  const ext=service._settings().backup_external_path;
  if(ext){try{fs.mkdirSync(ext,{recursive:true});fs.copyFileSync(dest,path.join(ext,path.basename(dest)));}catch(e){/* Local verified backup is kept; external copy failed. */}}
  const existing=fs.readdirSync(dir).filter(f=>/^store-.*\.db$/.test(f)).sort().reverse();
  // Keep 72 recent snapshots (roughly 18h at 15 min) plus a daily snapshot over 30 days.
  const keep=new Set(existing.slice(0,72));const days=new Set();for(const f of existing){const day=f.slice(6,16);if(days.size<30&&!days.has(day)){days.add(day);keep.add(f);}}
  for(const f of existing)if(!keep.has(f))fs.unlinkSync(path.join(dir,f));
  return {file:path.basename(dest),bytes:fs.statSync(dest).size,reason,external_copy_requested:!!ext};
 }finally{busyBackup=false;try{if(fs.existsSync(tmp))fs.unlinkSync(tmp);}catch(_){}}
}
function listBackups(){fs.mkdirSync(backupDir(),{recursive:true});return fs.readdirSync(backupDir()).filter(x=>/^store-.*\.db$/.test(x)).sort().reverse().map(f=>({file:f,bytes:fs.statSync(path.join(backupDir(),f)).size}));}
function receiptHtml(s,duplicate=false,a4=false){
 const setting=service._settings();const width=setting.receipt_width==='58'?'58':'80';const rows=s.items.map(i=>`<tr><td>${safeName(i.product_name)}<small> × ${i.qty}</small></td><td style="text-align:right">${money(i.line_total)}</td></tr>`).join('');
 const pays=s.payments.map(p=>`<div>${safeName(p.method.toUpperCase())}: ${money(p.amount)}</div>`).join('');
 const css=`@page {size:${a4?'A4':width+'mm auto'};margin:${a4?'16mm':'3mm'}}body{font-family:Arial,sans-serif;color:#111;font-size:${a4?'12':'11'}px;max-width:${a4?'700':width==='58'?'205':'285'}px;margin:0 auto}h1,h2,p{text-align:center;margin:5px 0}table{width:100%;border-collapse:collapse}th,td{padding:7px 2px;border-bottom:1px solid #ddd;text-align:left}.total{font-size:17px;font-weight:bold;border-top:2px solid #111;margin:12px 0;padding:10px 0}.muted{color:#666}.row{display:flex;justify-content:space-between;margin:5px 0}`;
 return `<!doctype html><html><head><meta charset="utf-8"><style>${css}</style></head><body>${duplicate?'<h2>DUPLICATE COPY</h2>':''}<h1>${safeName(setting.shop_name||'Electric Store')}</h1><p>${safeName(setting.shop_address||'')}</p><p>${safeName(setting.shop_phone||'')}</p><hr><div class="row"><span>Bill: <b>${safeName(s.bill_no)}</b></span><span>${new Date(s.created_at).toLocaleString('en-PK',{timeZone:'Asia/Karachi'})}</span></div><div>Customer: ${safeName(s.customer_name||'Walk-in')}</div><table><thead><tr><th>Item</th><th style="text-align:right">Total</th></tr></thead><tbody>${rows}</tbody></table><div class="row"><span>Subtotal</span><span>${money(s.subtotal)}</span></div><div class="row"><span>Bill discount</span><span>${money(s.discount)}</span></div><div class="row total"><span>TOTAL</span><span>${money(s.total)}</span></div>${pays}<div class="row"><span>Udhaar</span><span>${money(s.outstanding)}</span></div><hr><p>${safeName(setting.receipt_footer||'Thank you for shopping with us!')}</p></body></html>`;
}
async function printSale(saleId,format='thermal',pdf=false){
 service._check('sales:detail');const s=service._saleDetail(Number(saleId));const duplicate=!!s.printed;
 const popup=new BrowserWindow({show:false,width:740,height:920,webPreferences:{sandbox:true,nodeIntegration:false,contextIsolation:true}});
 try{
  await popup.loadURL('data:text/html;charset=utf-8,'+encodeURIComponent(receiptHtml(s,duplicate,format==='a4')));
  if(pdf){const out=await dialog.showSaveDialog(win,{title:'Save invoice PDF',defaultPath:`Invoice-${s.bill_no}.pdf`,filters:[{name:'PDF',extensions:['pdf']}]});if(out.canceled)return {cancelled:true};const bytes=await popup.webContents.printToPDF({pageSize:'A4',printBackground:true});fs.writeFileSync(out.filePath+'.tmp',bytes);fs.renameSync(out.filePath+'.tmp',out.filePath);return {saved:out.filePath};}
  return await new Promise(resolve=>popup.webContents.print({silent:false,printBackground:true},(success,reason)=>{if(success){db.prepare('UPDATE sales SET printed=1 WHERE id=?').run(s.id);resolve({ok:true});}else resolve({ok:false,error:reason||'Printing canceled'});}));
 }finally{if(!popup.isDestroyed())popup.close();}
}
function csv(val){const s=String(val??'');return /[",\n\r]/.test(s)?'"'+s.replace(/"/g,'""')+'"':s;}
async function exportFile(kind,query){let headers,rows;
 if(kind==='products'){service._check('products:list');headers=['id','name','brand','model','category','unit','barcode','sku','aliases','cost_price','retail_price','min_price','reorder_level','stock_qty','is_active'];rows=(await service.action('products:list')).map(p=>({...p,cost_price:p.cost_price===undefined?'':(p.cost_price/100).toFixed(2),retail_price:(p.retail_price/100).toFixed(2),min_price:p.min_price===undefined?'':(p.min_price/100).toFixed(2)}));if(!service._cost())headers=headers.filter(x=>!['cost_price','min_price'].includes(x));}
 else if(kind==='customers'){service._check('customers:list');headers=['id','name','phone','address','credit_limit','balance'];rows=await service.action('customers:list');}
 else if(kind==='sales'){service._check('sales:list');headers=['bill_no','customer_name','total','paid','outstanding','created_at'];rows=await service.action('sales:list');}
 else if(kind==='profit'){service._check('reports:summary');headers=['from','to','revenue','discounts','returns','cogs','gross_profit','expenses','net_profit'];rows=[await service.action('reports:summary',query)];}
 else throw Error('Unknown export type');
 const out=await dialog.showSaveDialog(win,{title:'Export CSV',defaultPath:`${kind}-${new Date().toISOString().slice(0,10)}.csv`,filters:[{name:'CSV file',extensions:['csv']}]});if(out.canceled)return {cancelled:true};
 const body='\uFEFF'+headers.join(',')+'\r\n'+rows.map(r=>headers.map(h=>csv(r[h])).join(',')).join('\r\n');fs.writeFileSync(out.filePath+'.tmp',body,'utf8');fs.renameSync(out.filePath+'.tmp',out.filePath);
 return {saved:out.filePath,count:rows.length};
}
async function importExcel(){
 service._check('products:save');
 const picked=await dialog.showOpenDialog(win,{title:'Import product Excel workbook',properties:['openFile'],filters:[{name:'Excel workbook',extensions:['xlsx']}]});
 if(picked.canceled)return {cancelled:true};
 const ExcelJS=require('exceljs');const book=new ExcelJS.Workbook();await book.xlsx.readFile(picked.filePaths[0]);const sheet=book.worksheets[0];
 if(!sheet)throw Error('Workbook has no worksheets');
 const headers=sheet.getRow(1).values.slice(1).map(x=>String(x||'').trim().toLowerCase());const rows=[];
 sheet.eachRow((r,n)=>{if(n===1)return;const v=r.values.slice(1);const obj=Object.fromEntries(headers.map((h,i)=>[h,v[i]??'']));if(!obj.name)return;
  rows.push({id:Number(obj.id)||0,name:String(obj.name),brand:String(obj.brand||''),model:String(obj.model||''),category:String(obj.category||''),unit:String(obj.unit||'pcs'),barcode:String(obj.barcode||''),sku:String(obj.sku||''),aliases:String(obj.aliases||''),description:String(obj.description||''),cost_price:Math.round(Number(obj.cost_price||0)*100),retail_price:Math.round(Number(obj.retail_price||0)*100),min_price:Math.round(Number(obj.min_price||0)*100),reorder_level:Number(obj.reorder_level||0),opening_qty:Number(obj.stock_qty||obj.opening_qty||0)});
 });
 if(rows.length>5000)throw Error('Import only 5000 products per workbook');return {rows};
}
async function exportExcel(kind,query){
 const ExcelJS=require('exceljs');let headers,rows;
 if(kind==='products'){service._check('products:list');headers=['id','name','brand','model','category','unit','barcode','sku','aliases','cost_price','retail_price','min_price','reorder_level','stock_qty','is_active'];rows=(await service.action('products:list')).map(p=>({...p,cost_price:p.cost_price===undefined?'':p.cost_price/100,retail_price:p.retail_price/100,min_price:p.min_price===undefined?'':p.min_price/100}));if(!service._cost())headers=headers.filter(h=>!['cost_price','min_price'].includes(h));}
 else if(kind==='profit'){service._check('reports:summary');headers=['from','to','revenue','discounts','returns','cogs','gross_profit','expenses','net_profit','margin_percent','bills'];const report=await service.action('reports:summary',query);rows=[Object.fromEntries(Object.entries(report).map(([k,v])=>[k,['revenue','discounts','returns','cogs','gross_profit','expenses','net_profit'].includes(k)?v/100:v]))];}
 else if(kind==='sales'){service._check('sales:list');headers=['bill_no','customer_name','total','paid','outstanding','created_at'];rows=(await service.action('sales:list')).map(p=>({...p,total:p.total/100,paid:p.paid/100,outstanding:p.outstanding/100}));}
 else throw Error('Unknown report');
 const pick=await dialog.showSaveDialog(win,{title:'Export Excel workbook',defaultPath:`${kind}-${new Date().toISOString().slice(0,10)}.xlsx`,filters:[{name:'Excel',extensions:['xlsx']}]});if(pick.canceled)return {cancelled:true};
 const book=new ExcelJS.Workbook();const sheet=book.addWorksheet(kind[0].toUpperCase()+kind.slice(1));sheet.columns=headers.map(h=>({header:h,key:h,width:Math.max(18,Math.min(35,h.length+8))}));sheet.getRow(1).font={bold:true};for(const r of rows)sheet.addRow(r);
 const tmp=pick.filePath+'.tmp.xlsx';await book.xlsx.writeFile(tmp);fs.renameSync(tmp,pick.filePath);return {saved:pick.filePath,count:rows.length};
}
async function exportProfitPdf(params){
 service._check('reports:summary');const p=await service.action('reports:summary',params),settings=service._settings();
 const lines=[['Net revenue',p.revenue],['Bill discounts',p.discounts],['Returns',p.returns],['COGS',p.cogs],['Gross profit',p.gross_profit],['Expenses',p.expenses],['Net profit',p.net_profit]];
 const html=`<!doctype html><html><head><meta charset="utf-8"><style>@page{size:A4;margin:18mm}body{font-family:Arial;color:#1f3049}h1{font-size:25px}h2{font-size:17px;color:#3056a5}p{color:#6d819d}table{border-collapse:collapse;width:100%;margin:25px 0}td{padding:12px;border-bottom:1px solid #e4eaf5}td:last-child{text-align:right}tr:last-child{font-weight:bold;background:#eef4ff}.foot{margin-top:50px;color:#8698ad;font-size:10px}</style></head><body><h1>${safeName(settings.shop_name||'Electric Store')}</h1><h2>Profit report</h2><p>From ${safeName(params.from)} to ${safeName(params.to)} · ${p.bills} bills</p><table>${lines.map(([k,v])=>`<tr><td>${safeName(k)}</td><td>${money(v)}</td></tr>`).join('')}</table><p>Margin: ${p.margin_percent}%</p><p class="foot">Generated locally by Electric Store POS. Returns use their own transaction dates.</p></body></html>`;
 const choice=await dialog.showSaveDialog(win,{defaultPath:`Profit-${params.from}-${params.to}.pdf`,filters:[{name:'PDF',extensions:['pdf']}]});if(choice.canceled)return {cancelled:true};const popup=new BrowserWindow({show:false,webPreferences:{sandbox:true,nodeIntegration:false}});
 try{await popup.loadURL('data:text/html;charset=utf-8,'+encodeURIComponent(html));const buffer=await popup.webContents.printToPDF({pageSize:'A4',printBackground:true});fs.writeFileSync(choice.filePath+'.tmp',buffer);fs.renameSync(choice.filePath+'.tmp',choice.filePath);return {saved:choice.filePath}}finally{popup.close()}
}
function createWindow(){
 win=new BrowserWindow({title:'Electric Store POS',width:1440,height:900,minWidth:990,minHeight:650,backgroundColor:'#101b30',show:false,webPreferences:{preload:path.join(__dirname,'preload.cjs'),nodeIntegration:false,contextIsolation:true,sandbox:true,webSecurity:true}});
 win.webContents.setWindowOpenHandler(()=>({action:'deny'}));win.webContents.on('will-navigate',event=>event.preventDefault());
 const dev=process.env.ELECTRON_DEV_SERVER_URL;
 if(dev)win.loadURL(dev);else win.loadFile(path.join(__dirname,'../dist/index.html'));
 win.once('ready-to-show',()=>win.show());
}
function registerHandlers(){
 ipcMain.handle('shop:invoke',async(_event,action,x={})=>{
  try{
   if(action==='backup:list'){service._check('settings:save');return {ok:true,data:listBackups()};}
   if(action==='backup:run'){service._check('settings:save');return {ok:true,data:await makeBackup('manual')};}
   if(action==='backup:restore'){
    service._check('settings:save');const file=String(x.file||'');if(!/^store-[\w-]+\.db$/.test(file))throw Error('Invalid backup name');
    const source=path.join(backupDir(),file);if(!fs.existsSync(source))throw Error('Backup missing');
    const choice=await dialog.showMessageBox(win,{type:'warning',buttons:['Cancel','Restore and restart'],defaultId:0,cancelId:0,title:'Restore backup',message:`Replace current store data with ${file}?`,detail:'A safety copy of your current database will be kept. Newer sales may be lost.'});
    if(choice.response!==1)return {ok:true,data:{cancelled:true}};
    await makeBackup('before-restore');const dbFile=path.join(dataDir(),'store.db');db.close();
    fs.copyFileSync(source,dbFile+'.restore-new');fs.copyFileSync(dbFile,dbFile+'.before-restore-'+Date.now());fs.renameSync(dbFile+'.restore-new',dbFile);
    skipExitBackup=true;app.relaunch();setImmediate(()=>app.quit());return {ok:true,data:{restarting:true}};
   }
   if(action==='sales:print'){return {ok:true,data:await printSale(x.id,x.format||'thermal',!!x.pdf)};}
   if(action==='export:csv'){return {ok:true,data:await exportFile(x.kind,x.query||{})};}
   if(action==='export:xlsx'){return {ok:true,data:await exportExcel(x.kind,x.query||{})};}
   if(action==='export:profitPdf'){return {ok:true,data:await exportProfitPdf(x.query||{})};}
   if(action==='products:openExcel'){return {ok:true,data:await importExcel()};}
   if(action==='backup:chooseFolder'){service._check('settings:save');const d=await dialog.showOpenDialog(win,{properties:['openDirectory','createDirectory']});return {ok:true,data:d.canceled?null:d.filePaths[0]};}
   const data=await service.action(action,x);return {ok:true,data};
  }catch(e){console.error('[shop]',action,e.message);return {ok:false,error:e.message||'Operation failed'};}
 });
}
app.whenReady().then(()=>{
 try{fs.mkdirSync(dataDir(),{recursive:true});db=openDb(path.join(dataDir(),'store.db'));if(!integrity(db))throw Error('Database integrity check failed. Restore a verified backup before using the shop.');service=new ShopService(db);registerHandlers();createWindow();backupTimer=setInterval(()=>{makeBackup('timer').catch(e=>console.error('Backup failed:',e.message));},15*60*1000);}
 catch(e){dialog.showErrorBox('Electric Store POS - startup error',String(e.message));app.quit();}
});
app.on('window-all-closed',()=>{if(process.platform!=='darwin')app.quit();});
app.on('activate',()=>{if(BrowserWindow.getAllWindows().length===0&&service)createWindow();});
app.on('before-quit',event=>{if(backupTimer)clearInterval(backupTimer);if(exitBackupDone||skipExitBackup||!db)return;event.preventDefault();exitBackupDone=true;makeBackup('quit').catch(e=>console.error('Exit backup:',e.message)).finally(()=>{try{db.close()}catch(_){}app.quit()});});
