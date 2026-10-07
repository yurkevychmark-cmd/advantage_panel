const fs=require('fs');
const esbuild=require('/Users/macbookpro15/Desktop/Platform/portal/node_modules/esbuild');
function check(file){
  const html=fs.readFileSync(file,'utf8');
  const m=html.match(/<script type="text\/babel">([\s\S]*?)<\/script>/);
  if(!m){console.log(`${file}: NO babel script`);return false;}
  try{ esbuild.transformSync(m[1],{loader:'jsx',jsx:'transform'});
    console.log(`OK ${file}: JSX compiles clean`); return true;
  }catch(e){ console.log(`FAIL ${file}:`); (e.errors||[]).forEach(er=>console.log(`   ${er.text} @ line ${er.location&&er.location.line}`)); return false; }
}
const a=check('index.html'), b=check('index.v11.html');
process.exit(a&&b?0:1);
