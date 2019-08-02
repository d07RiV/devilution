const fs = require('fs-extra');
const fsp = fs.promises;
const path = require('path');
const { exec } = require('child_process');

function async_limit(func, limit) {
  const executing = [];
  return async function(...args) {
    while (executing.length >= limit) {
      await Promise.race(executing).catch(() => null);
    }
    const p = Promise.resolve().then(() => func(...args));
    const e = p.finally(() => executing.splice(executing.indexOf(e), 1));
    executing.push(e);
    return p;
  };
}
const execute = async_limit((cmd, cb) => new Promise((resolve, reject) => {
  if (cb) cb();
  exec(cmd, function(err, stdout, stderr) {
    if (err) {
      reject(err);
    } else {
      resolve({stdout, stderr});
    }
  });
}), 6);

const flags = process.argv.slice(2).join(" ");

const is_spawn = flags.match(/-DSPAWN/);
const out_dir = is_spawn ? './emcc/spawn' : './emcc/retail';

let rebuild = true;
if (fs.existsSync(`${out_dir}/args.txt`)) {
  if (fs.readFileSync(`${out_dir}/args.txt`, 'utf8') === flags) {
    rebuild = false;
  }
}

const link_list = [];
let firstFile = true;
let maxTime = null;

let fileTime = new Map();
function file_time(name) {
  if (fileTime.has(name)) {
    return fileTime.get(name);
  }
  const time = (async () => {
    const data = await fsp.readFile(name, 'utf8');
    const reg = /^\s*#include "(.*)"/mg;
    let m;
    const includes = [];
    const dir = path.dirname(name);
    while (m = reg.exec(data)) {
      includes.push(path.join(dir, m[1]));
    }
    const incl = includes.map(n => file_time(n));
    const times = await Promise.all(incl);
    const time = times.reduce((res, t) => (res > t ? res : t), (await fsp.stat(name)).mtime);
    return time;
  })();
  fileTime.set(name, time);
  return time;
}

async function handle_file(name) {
  const statSrc = await fsp.stat(name);
  if (statSrc.isDirectory()) {
    const list = await fsp.readdir(name);
    await Promise.all(list.map(fn => handle_file(`${name}/${fn}`)));
  } else if (name.match(/\.(?:c|cpp|cc)$/i)) {
    const out = `${out_dir}/${name}.bc`;
    const srcTime = await file_time(name);
    let statDst = null;
    if (fs.existsSync(out)) {
      statDst = await fsp.stat(out);
    } else {
      fs.createFileSync(out);
    }

    if (rebuild || !statDst || srcTime > statDst.mtime) {
      if (firstFile) {
        console.log('Compiling...');
        firstFile = false;
      }
      const cmd = `emcc ${name} -o ${out} ${name.match(/\.(?:cpp|cc)$/i) ? "--std=c++11 " : ""}-DNO_SYSTEM -DEMSCRIPTEN -Wno-logical-op-parentheses ${flags} -I.`;
      try {
        const {stderr} = await execute(cmd, () => console.log(`  ${name}`));
        if (stderr) {
          console.error(stderr);
        }
      } catch (e) {
        if (fs.existsSync(out)) {
          await fsp.unlink(out);
        }
        throw e;
      }
    }

    if (!maxTime || statSrc.mtime > maxTime) {
      maxTime = statSrc.mtime;
    }

    link_list.push(out);
  }
}

async function build_all() {
  await handle_file('Source');
  fs.createFileSync(`${out_dir}/args.txt`);
  fs.writeFileSync(`${out_dir}/args.txt`, flags);

  const oname = (is_spawn ? 'DiabloSpawn' : 'Diablo');

  if (!rebuild && (!maxTime || maxTime <= fs.statSync(oname + '.wasm').mtime)) {
    console.log('Everything is up to date');
    return;    
  }

  console.log(`Linking ${is_spawn ? 'spawn' : 'retail'}`);

  const cmd = `emcc ${link_list.join(" ")} -o ${oname}.js -s EXPORT_NAME="${oname}" ${flags} -s WASM=1 -s MODULARIZE=1 -s NO_FILESYSTEM=1 --post-js ./module-post.js -s ALLOW_MEMORY_GROWTH=1 -s TOTAL_MEMORY=134217728 -s DISABLE_EXCEPTION_CATCHING=0`;
  const {stderr} = await execute(cmd);
  if (stderr) {
    console.error(stderr);
  }
  fs.renameSync(oname + '.js', oname + '.jscc');
}

build_all().catch(e => console.error(e.message));
