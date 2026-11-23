export function filterTransactions(rows,filters={}){
 const {search='',type='',product='',warehouse='',user='',from='',to=''}=filters;
 const term=String(search).trim().toLowerCase();
 return rows.filter(row=>{
  const day=String(row.created_at||'').slice(0,10);
  const searchable=`${row.product_name||''} ${row.sku||''} ${row.reference||''} ${row.note||''} ${row.user_name||''} ${row.warehouse_name||''}`.toLowerCase();
  return (!term||searchable.includes(term))&&(!type||row.type===type)&&(!product||String(row.product_id)===String(product))&&(!warehouse||String(row.warehouse_id)===String(warehouse))&&(!user||row.user_name===user)&&(!from||day>=from)&&(!to||day<=to);
 });
}

export function summarizeTransactions(rows){
 return {all:rows.length,in:rows.filter(row=>row.type==='stock_in').length,out:rows.filter(row=>row.type==='stock_out').length,transfer:rows.filter(row=>String(row.type||'').startsWith('transfer_')).length};
}

export function formatTransactionDate(value){
 if(!value)return '—';
 const parsed=new Date(value);
 return Number.isNaN(parsed.getTime())?String(value):new Intl.DateTimeFormat('en',{dateStyle:'medium',timeStyle:'short'}).format(parsed);
}
