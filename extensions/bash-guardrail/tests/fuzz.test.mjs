import { classify } from "../classify.ts";
const nasty=["","   ","'","\"","cat '","cat \"unclosed","ls -","grep","grep -e","sed -n","find -name","| head","&&","cd","cd ..","$(",'`',"<<EOF","x".repeat(50000),"ls "+"a/".repeat(5000),"grep -rn \"[\" .","grep -rn '\\' .","rm -rf /","rm -rf ~","rm -rf $HOME","echo $(rm -rf /)","ls\u0000-la","cat 🙂.kt","ls --",'grep -A - .',"head -n",'diff',"wc","du","git","git log --",'cp',"ln -s","chmod","touch","npm","npx","./gradlew","unzip","jar","which","printenv","env | grep","echo $X"];
let bad=0;
for(const s of nasty){ try{ const d=classify(s,{cwd:"/tmp",statPath:()=>"unknown"}); if(!d||!d.kind) {console.log("BAD RESULT",JSON.stringify(s).slice(0,60));bad++;} } catch(e){ console.log("THREW on",JSON.stringify(s).slice(0,60),e.message); bad++; } }
// fuzz: random byte soup
const chars=`abcABC012 '"\`$|&;()<>{}[]*?!#\\\n\t/-=.,:~`;
for(let i=0;i<20000;i++){let s="";const n=1+Math.floor(Math.random()*40);for(let j=0;j<n;j++)s+=chars[Math.floor(Math.random()*chars.length)];
 try{ const d=classify(s,{cwd:"/tmp",statPath:()=>"unknown"}); if(!d||!d.kind){console.log("BAD",JSON.stringify(s));bad++;} }catch(e){ console.log("THREW on",JSON.stringify(s),e.message); bad++; if(bad>5)break; } }
console.log(bad?bad+" problems":"fuzz: 20k random inputs + 50 edge cases, no throws, always a decision");
