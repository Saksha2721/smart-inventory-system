import 'dotenv/config';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import initSqlJs from 'sql.js';

const here=path.dirname(fileURLToPath(import.meta.url));
const tableOrder=['suppliers','users','warehouses','products','sessions','warehouse_assignments','login_attempts','inventory','purchase_orders','purchase_order_items','purchase_order_receipts','stock_transactions'];
const keyColumns={warehouse_assignments:['user_id','warehouse_id'],login_attempts:['key']};
const serialTables=['suppliers','users','warehouses','products','sessions','inventory','stock_transactions','purchase_orders','purchase_order_items','purchase_order_receipts'];

const sameValue=(column,expected,actual)=>{
  if(expected===null||actual===null)return expected===actual;
  if(column.endsWith('_at')){
    const iso=value=>{const text=String(value);const date=new Date(/(?:Z|[+-]\d\d:\d\d)$/.test(text)?text:`${text.replace(' ','T')}Z`);return Number.isNaN(date.valueOf())?text:date.toISOString();};
    return iso(expected)===iso(actual);
  }
  if(typeof expected==='number'||typeof actual==='number')return Number(expected)===Number(actual);
  return String(expected)===String(actual);
};

export async function migrateSqliteCopy({source,reportPath,database}={}){
  if(!database){
    if((process.env.DB_DRIVER||'').toLowerCase()!=='postgres'||!process.env.DATABASE_URL)throw new Error('Set DB_DRIVER=postgres and DATABASE_URL in your local .env before migration.');
    database=(await import('./database.js')).db;
  }
  source=path.resolve(source||process.env.SQLITE_SOURCE_PATH||path.join(here,'inventory.auth-demo.db'));
  reportPath=path.resolve(reportPath||process.env.MIGRATION_REPORT_PATH||path.join(here,'migration-report.json'));
  if(!fs.existsSync(source))throw new Error(`SQLite source database not found: ${source}`);
  const tempDir=fs.mkdtempSync(path.join(os.tmpdir(),'stockflow-pg-migration-'));
  const copyPath=path.join(tempDir,'source-copy.db');
  const report={started_at:new Date().toISOString(),source_file:path.basename(source),status:'failed',tables:{}};
  try{
    // Read only an isolated copy; neither SQLite connection nor migration code writes to source.
    fs.copyFileSync(source,copyPath);
    const SQL=await initSqlJs();
    const sqlite=new SQL.Database(new Uint8Array(fs.readFileSync(copyPath)));
    sqlite.run('PRAGMA foreign_keys=ON');
    const integrity=sqlite.exec('PRAGMA integrity_check')[0]?.values?.[0]?.[0];
    const foreignViolations=sqlite.exec('PRAGMA foreign_key_check')[0]?.values||[];
    if(integrity!=='ok'||foreignViolations.length)throw new Error('The copied SQLite database did not pass integrity or foreign-key checks.');

    const sourceRows=new Map();
    for(const table of tableOrder){
      const columns=sqlite.exec(`PRAGMA table_info(${table})`)[0]?.values.map(row=>row[1])||[];
      if(!columns.length)throw new Error(`Required SQLite table is missing: ${table}`);
      const result=sqlite.exec(`SELECT * FROM ${table}`)[0];
      const rows=result?result.values.map(values=>Object.fromEntries(result.columns.map((column,index)=>[column,values[index]]))):[];
      sourceRows.set(table,{columns,rows});
      report.tables[table]={source_rows:rows.length,migrated_rows:0,mismatches:0};
    }

    await database.transaction(async()=>{
      for(const table of tableOrder){
        const {columns,rows}=sourceRows.get(table),keys=keyColumns[table]||['id'];
        const insert=`INSERT INTO ${table} (${columns.join(',')}) VALUES (${columns.map(()=>'?').join(',')}) ON CONFLICT (${keys.join(',')}) DO NOTHING`;
        for(const row of rows){
          const values=columns.map(column=>{const value=row[column];if(typeof value==='string'&&column.endsWith('_at')&&!/(?:Z|[+-]\d\d:\d\d)$/.test(value))return `${value.replace(' ','T')}Z`;return value;});
          await database.prepare(insert).run(...values);
        }
      }
      for(const table of tableOrder){
        const {columns,rows}=sourceRows.get(table),keys=keyColumns[table]||['id'];
        const where=keys.map(key=>`${key}=?`).join(' AND ');
        for(const row of rows){
          const actual=await database.prepare(`SELECT ${columns.join(',')} FROM ${table} WHERE ${where}`).get(...keys.map(key=>row[key]));
          if(!actual||columns.some(column=>!sameValue(column,row[column],actual[column])))report.tables[table].mismatches++;
        }
        const targetCount=Number((await database.prepare(`SELECT COUNT(*) n FROM ${table}`).get()).n);
        report.tables[table].migrated_rows=targetCount;
        if(targetCount!==rows.length||report.tables[table].mismatches)throw new Error(`Verification failed for ${table}; destination rows differ or include unrelated records.`);
      }
      await database.exec('SET CONSTRAINTS ALL IMMEDIATE');
      for(const table of serialTables){if(report.tables[table].source_rows)await database.exec(`SELECT setval(pg_get_serial_sequence('${table}','id'),(SELECT MAX(id) FROM ${table}),true)`);}
    })();

    report.status='verified';
    report.finished_at=new Date().toISOString();
    report.sqlite_integrity=integrity;
    report.sqlite_foreign_key_violations=foreignViolations.length;
    report.password_hashes='copied without output';
    fs.mkdirSync(path.dirname(reportPath),{recursive:true});
    fs.writeFileSync(reportPath,`${JSON.stringify(report,null,2)}\n`,{mode:0o600});
    return report;
  }catch(error){
    report.finished_at=new Date().toISOString();
    report.error=error.message;
    fs.mkdirSync(path.dirname(reportPath),{recursive:true});
    fs.writeFileSync(reportPath,`${JSON.stringify(report,null,2)}\n`,{mode:0o600});
    throw error;
  }finally{
    fs.rmSync(tempDir,{recursive:true,force:true});
  }
}

if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url){
  try{
    if((process.env.DB_DRIVER||'').toLowerCase()!=='postgres'||!process.env.DATABASE_URL)throw new Error('Set DB_DRIVER=postgres and DATABASE_URL in your local .env before migration.');
    const report=await migrateSqliteCopy();
    console.log(`Migration verified. Report saved to ${path.resolve(process.env.MIGRATION_REPORT_PATH||path.join(here,'migration-report.json'))}`);
    console.log(JSON.stringify(report,null,2));
  }catch(error){console.error(`Migration failed: ${error.message}`);process.exitCode=1;}
}
