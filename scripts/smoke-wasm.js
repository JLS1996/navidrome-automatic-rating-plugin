"use strict";
const assert=require("node:assert/strict");
const path=require("node:path");
const fs=require("node:fs"),os=require("node:os"),{spawnSync}=require("node:child_process");
const {createPlugin}=require("@extism/extism");
const {fixture}=require("../test/helpers");
const {decode}=require("../src/plugin");
const wasm=path.resolve(__dirname,"../dist/plugin.wasm");
const names=["subsonicapi_call","users_getusers","library_getalllibraries","scheduler_schedulerecurring",
  "scheduler_cancelschedule","kvstore_get","kvstore_set","kvstore_list"];
async function invoke(h,config,fn,input="") {
  const functions={"extism:host/user":Object.fromEntries(names.map(name=>[name,(cp,ptr)=>cp.store(JSON.stringify(h.host(name,cp.read(ptr).json())))]))};
  const logger=Object.fromEntries(["trace","debug","info","warn","error"].map(level=>[level,(...parts)=>{
    const message=parts.join(" ");if(message.startsWith("Automatic Ratings: "))h.logs.push([level,message]);
  }]));
  const plugin=await createPlugin(wasm,{useWasi:true,functions,config,logger,logLevel:"debug"});
  try{return await plugin.call(fn,input);}finally{await plugin.close();}
}
async function worker(h,c){await invoke(h,c,"nd_scheduler_callback",JSON.stringify({payload:"worker"}));}
async function again(h,c){c.run_now="false";await worker(h,c);c.run_now="true";await worker(h,c);}
(async()=>{
  const h=fixture(),config={run_now:"true",batch_size:"1"};
  await invoke(h,config,"nd_on_init");
  const output=await invoke(h,config,"automatic_ratings_calculate",JSON.stringify({histogram:[0,1,0,1,0,0]}));
  assert.equal(output.json().rating,3);
  for(const [weight,rating]of[[3.3,3],[3.2999999999999994,2]]){
    const fractional=await invoke(h,config,"automatic_ratings_calculate",JSON.stringify({
      histogram:[0,1,0,1,0,0],options:{weights:[1.1,1,weight,1,1]}}));
    assert.equal(fractional.json().rating,rating);
  }
  await worker(h,config);
  assert.equal(h.state().active,false);assert.deepEqual(h.writes,[]);
  const artist=h.events("item").find(e=>e.kind==="artist"&&e.id==="album-artist"&&e.user==="example-reader");
  assert.equal(artist.proposedRating,3);assert.equal(artist.totalSongs,5);
  assert.equal(h.events("run_summary").length,1);
  assert.equal(h.events("user_summary")[1].skipped,true);
  assert.equal(h.calls.filter(c=>c.request.uri?.startsWith("getAlbum?")&&c.request.uri.includes("u=example-unrated")).length,0);
  // Every invocation uses a fresh WASM instance, as Navidrome does.
  await worker(h,config);assert.equal(h.events("run_summary").length,1);
  config.dry_run="false";await again(h,config);
  assert.equal(h.getRating("example-reader","album","album-a"),5);
  assert.equal(h.getRating("example-reader","artist","album-artist"),3);
  assert.equal(h.writes.length,3);
  h.setRating("example-reader","album","album-a",2);
  for(const song of h.albums[1].songs)song.userRating=5;
  await again(h,config);
  assert.equal(h.getRating("example-reader","album","album-a"),2);
  assert.equal(h.getRating("example-reader","album","album-b"),5);
  assert.equal(h.getRating("example-reader","artist","album-artist"),5);
  // Exercise the destructive branch against fictional host data only.
  h.setRating("example-reader","album","album-low",4);h.setRating("example-reader","artist","low-artist",4);
  config.album_rating_policy="replace";config.artist_rating_policy="replace";
  await again(h,config);
  assert.equal(h.getRating("example-reader","album","album-low"),0);
  assert.equal(h.getRating("example-reader","artist","low-artist"),0);
  config.artist_attribution="performing_artist";
  await again(h,config);
  assert.equal(h.getRating("example-reader","artist","guest-artist"),5);
  for(const album of h.albums)for(const song of album.songs)song.userRating=0;
  config.album_rating_policy="preserve";config.artist_rating_policy="preserve";
  await again(h,config);
  assert.equal(h.getRating("example-reader","artist","guest-artist"),0);
  assert.equal(h.getRating("example-reader","album","album-b"),0);
  const lastUsers=h.events("user_summary").slice(-2);
  assert.ok(lastUsers.every(e=>e.ratedSongs===0));
  assert.equal(lastUsers[0].sourceVerified,true); // Owned clears require revalidation.
  assert.equal(lastUsers[1].sourceVerified,false); // No-op user avoids the second pass.
  assert.equal(h.schedules.size,2);
  for(const[key,value]of h.storage)if(key.includes("owner:"))assert.equal(decode(value).pending,null);
  const audit=fixture(),auditConfig={run_now:"true",audit_logging:"true"};
  await invoke(audit,auditConfig,"nd_on_init");await worker(audit,auditConfig);
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),"automatic-ratings-wasm-audit-"));
  try{const file=path.join(temp,"fixture.log");fs.writeFileSync(file,audit.logs.map(([,line])=>line).join("\n"));
    const checked=spawnSync("python3",[path.resolve(__dirname,"verify-audit.py"),file],{encoding:"utf8",timeout:15000});
    assert.equal(checked.status,0,checked.stdout+checked.stderr);assert.equal(JSON.parse(checked.stdout).verifiedArtists,4);
  }finally{fs.rmSync(temp,{recursive:true,force:true});}
  console.log("Compiled WASM smoke passed: independent outputs, exact fractional ties, dry-run isolation, ownership, clears, performing credits, safe unrated-user skips, native host imports, scheduler rearming, and independent audit verification.");
})().catch(error=>{console.error(error);process.exitCode=1;});
