import 'dotenv/config';
import { randomBytes, scrypt as scryptCallback } from 'node:crypto';
import { promisify } from 'node:util';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { db } from './database.js';

const scrypt=promisify(scryptCallback);
async function passwordHash(password){const salt=randomBytes(16);const derived=await scrypt(password,salt,64,{N:16384,r:8,p:1});return `scrypt$${salt.toString('hex')}$${Buffer.from(derived).toString('hex')}`;}
async function hiddenPassword(){
 if(!input.isTTY||!input.setRawMode)throw new Error('Run this command in an interactive terminal so the password can be entered without echoing.');
 output.write('Admin password (12+ characters; input hidden): ');input.setRawMode(true);input.resume();let value='';
 try{return await new Promise((resolve,reject)=>{const handler=chunk=>{for(const char of chunk.toString()){if(char==='\u0003'){input.off('data',handler);reject(new Error('Cancelled.'));return;}if(char==='\r'||char==='\n'){input.off('data',handler);output.write('\n');resolve(value);return;}if(char==='\u007f'||char==='\b')value=value.slice(0,-1);else if(char>=' ')value+=char;}};input.on('data',handler);});}
 finally{input.setRawMode(false);}
}
const rl=createInterface({input,output});
try{
 const name=(await rl.question('Admin full name: ')).trim();
 const email=(await rl.question('Admin email: ')).trim().toLowerCase();
 rl.close();
 const password=await hiddenPassword();
 if(!name||name.length>120||!/^\S+@\S+\.\S+$/.test(email)||password.length<12||password.length>128)throw new Error('Provide a name, valid email, and password of 12–128 characters.');
 const active=await db.prepare("SELECT id FROM users WHERE role='admin' AND active=1 AND password_hash IS NOT NULL LIMIT 1").get();
 if(active)throw new Error('An active administrator already exists. Sign in and create any additional accounts from Employee management.');
 const existing=await db.prepare('SELECT id,role FROM users WHERE email=?').get(email);
 if(existing&&existing.role!=='admin')throw new Error('That email belongs to a non-admin account; choose another address.');
 const encoded=await passwordHash(password);
 if(existing)await db.prepare('UPDATE users SET name=?,password_hash=?,active=1 WHERE id=?').run(name,encoded,existing.id);
 else await db.prepare("INSERT INTO users(name,email,role,password_hash,active) VALUES(?,?,'admin',?,1)").run(name,email,encoded);
 await db.prepare('DELETE FROM login_attempts').run();
 output.write(`Initial administrator is ready: ${email}\n`);
}catch(error){output.write(`Admin setup failed: ${error.message}\n`);process.exitCode=1;}
finally{rl.close();}
