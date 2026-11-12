"use strict";
const assert=require("node:assert/strict");
const path=require("node:path");
const fs=require("node:fs"),os=require("node:os"),{spawnSync}=require("node:child_process");
const {createPlugin}=require("@extism/extism");
const {fixture}=require("../test/helpers");
const {decode,ownerKey}=require("../src/plugin");
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
  for(const [histogram,weights,rating]of[[[0,4,0,0,0,1],[0,2,3,4,5],5],
    [[0,1,0,1,0,0],[1e-7,0,3e-7,0,0],3],[[0,1,0,0,0,1],[5e-324,0,0,0,1],5]]){
    const filtered=await invoke(h,config,"automatic_ratings_calculate",JSON.stringify({histogram,options:{weights}}));
    assert.equal(filtered.json().rating,rating);assert.ok(Number.isFinite(filtered.json().score));
  }
  await worker(h,config);
  assert.equal(h.state().active,false);assert.deepEqual(h.writes,[]);
  const artist=h.events("item").find(e=>e.kind==="artist"&&e.id==="album-artist"&&e.user==="example-reader");
  assert.equal(artist.proposedRating,3);assert.equal(artist.totalSongs,5);
  assert.equal(h.events("run_summary").length,1);
  assert.equal(h.events("run_summary")[0].auditLogging,false);
  assert.equal(h.events("run_summary")[0].auditSourceFormat,null);
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
  const guarded=fixture({users:["example-reader"]}),guardConfig={run_now:"true",dry_run:"false",rate_artists:"false"};
  const guardKey=ownerKey("example-reader","album","album-a");let scanStarted=false;
  guarded.after=(name,request)=>{
    if(name==="kvstore_set"&&request.key===guardKey&&decode(request.value).pending){scanStarted=true;guarded.scanning=true;}
  };
  await invoke(guarded,guardConfig,"nd_on_init");await worker(guarded,guardConfig);
  assert.equal(scanStarted,true);assert.deepEqual(guarded.writes,[]);
  assert.equal(decode(guarded.storage.get(guardKey)).pending,null);
  for (const kind of ["album", "artist"]) {
    const concurrent=fixture({users:["example-reader"]}),id=kind==="album"?"album-a":"album-artist";
    const key=ownerKey("example-reader",kind,id),cfg={run_now:"true",dry_run:"false",
      rate_albums:String(kind==="album"),rate_artists:String(kind==="artist")};
    concurrent.after=(name,request)=>{
      if(name==="kvstore_set"&&request.key===key&&decode(request.value).pending)
        concurrent.setRating("example-reader",kind,id,2);
    };
    await invoke(concurrent,cfg,"nd_on_init");await worker(concurrent,cfg);
    assert.equal(concurrent.getRating("example-reader",kind,id),2);
    assert.equal(concurrent.writes.some(w=>w.id===id),false);
    assert.equal(decode(concurrent.storage.get(key)).pending,null);
  }
  const excluded=fixture({users:["example-reader"]}),excludedConfig={run_now:"true",dry_run:"false",
    album_one_star_weight:"0",artist_one_star_weight:"0",album_rating_policy:"replace",artist_rating_policy:"replace"};
  excluded.setRating("example-reader","album","album-b",4);
  await invoke(excluded,excludedConfig,"nd_on_init");await worker(excluded,excludedConfig);
  assert.equal(excluded.getRating("example-reader","album","album-b"),4);
  assert.equal(excluded.getRating("example-reader","artist","album-artist"),5);
  const skipped=excluded.events("item").find(e=>e.kind==="album"&&e.id==="album-b");
  assert.equal(skipped.action,"skip_excluded");assert.equal(skipped.excludedSongs,4);
  assert.equal(skipped.eligibleSongs,0);assert.equal(skipped.contributingRatedSongs,0);
  for(const album of excluded.albums)for(const song of album.songs)song.userRating=0;
  await again(excluded,excludedConfig);
  assert.equal(excluded.getRating("example-reader","album","album-b"),0);
  assert.equal(excluded.getRating("example-reader","artist","album-artist"),0);
  const audit=fixture(),auditConfig={run_now:"true",audit_logging:"true",album_one_star_weight:"0",artist_one_star_weight:"0"};
  audit.albums[0].artists.push({id:"collaborator",name:"Example collaborator"});
  await invoke(audit,auditConfig,"nd_on_init");await worker(audit,auditConfig);
  assert.equal(audit.events("run_summary")[0].auditLogging,true);
  assert.equal(audit.events("run_summary")[0].auditSourceFormat,"structured_song_ratings_v1");
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),"automatic-ratings-wasm-audit-"));
  try{const file=path.join(temp,"fixture.log");fs.writeFileSync(file,audit.logs.map(([,line])=>line).join("\n"));
    const checked=spawnSync("python3",[path.resolve(__dirname,"verify-audit.py"),file,
      "--explain-artist","collaborator","--user","example-reader"],{encoding:"utf8",timeout:15000});
    assert.equal(checked.status,0,checked.stdout+checked.stderr);const report=JSON.parse(checked.stdout);
    assert.equal(report.verifiedArtists,6);assert.equal(report.artistExplanations.length,1);
    assert.equal(report.artistExplanations[0].calculatedRating,5);
    assert.deepEqual(report.artistExplanations[0].contributions[0].songs,
      [{id:"album-a-song-0",rating:5,artistIds:["album-artist","collaborator"]}]);
  }finally{fs.rmSync(temp,{recursive:true,force:true});}
  console.log("Compiled WASM smoke passed: independent outputs, exact fractional ties, zero-weight exclusions, dry-run isolation, ownership, clears, final write guards, performing credits, safe unrated-user skips, native host imports, scheduler rearming, audit status, and independent artist explanations.");
})().catch(error=>{console.error(error);process.exitCode=1;});
