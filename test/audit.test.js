"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),path=require("node:path");
const {execFile}=require("node:child_process"),{promisify}=require("node:util");
const runFile=promisify(execFile);
const fs=require("node:fs"),os=require("node:os");
const {fixture,ref}=require("./helpers");
const verifier=path.resolve(__dirname,"../scripts/verify-audit.py");
async function verify(input,args=[]){const dir=fs.mkdtempSync(path.join(os.tmpdir(),"automatic-ratings-audit-"));
  try{const file=path.join(dir,"fixture.jsonl");fs.writeFileSync(file,input);
    let result,status=0;
    try{result=await runFile("python3",[verifier,file,...args],{encoding:"utf8",timeout:15000});}
    catch(error){if(!Number.isInteger(error.code))throw error;status=error.code;result=error;}
    assert.ok(result.stdout,result.stderr);return {status,...JSON.parse(result.stdout)};
  }finally{fs.rmSync(dir,{recursive:true,force:true});}}
function plain(events){return events.map(e=>JSON.stringify(e)).join("\n");}
function audited(config={}){const h=fixture();h.albums[0].artists.push(ref("collaborator"),ref("album-artist"));
  h.run({audit_logging:true,...config});return h;}

test("independent verifier reproduces both outputs and structured collaboration credits",async()=>{
  const h=audited();const result=(await verify(plain(h.events())));
  assert.equal(result.status,0);assert.equal(result.ok,true);assert.equal(result.verifiedAlbums,8);
  assert.equal(result.verifiedArtists,6);assert.equal(result.sourceAlbums,8);
  const source=h.events("source_album")[0];assert.equal(source.albumArtistIds.length,3);
  assert.ok(h.logs.filter(([,line])=>line.includes('"event":"item"')).every(([level])=>level==="info"));
  assert.ok(h.events("user_summary").every(e=>e.skipped===false));
});
test("verifier accepts plain, prefixed, Navidrome JSON, and quoted Navidrome text logs",async()=>{
  const h=audited(),events=h.events();
  for(const render of [e=>JSON.stringify(e),e=>"Automatic Ratings: "+JSON.stringify(e),
    e=>JSON.stringify({time:"example",level:"info",msg:"Automatic Ratings: "+JSON.stringify(e)}),
    e=>`time="example" level=info msg=${JSON.stringify("Automatic Ratings: "+JSON.stringify(e))} plugin=automatic-ratings`]){
    assert.equal((await verify(events.map(render).join("\n"))).status,0);
  }
});
test("independent verification supports performing credits, custom weights, clears, and single outputs",async()=>{
  for(const config of [{artist_attribution:"performing_artist"},
    {album_one_star_weight:1.1,album_three_star_weight:3.3,artist_one_star_weight:1.1,artist_three_star_weight:3.3},
    {rate_albums:false},{rate_artists:false}])assert.equal((await verify(plain(audited(config).events()))).status,0);
  const h=fixture();h.setRating("example-reader","album","album-low",4);h.setRating("example-reader","artist","low-artist",4);
  h.run({audit_logging:true,album_rating_policy:"replace",artist_rating_policy:"replace"});
  assert.equal((await verify(plain(h.events()))).status,0);
});
test("verifier detects wrong scores, quotas, targets, and missing collaboration IDs",async()=>{
  const original=audited().events();
  for(const change of [events=>{events.find(e=>e.event==="item"&&e.kind==="artist").score=1;},
    events=>{events.find(e=>e.event==="item").requiredRatedSongs++;},
    events=>{events.find(e=>e.event==="item"&&e.action==="preview_update").proposedRating=2;},
    events=>{events.find(e=>e.event==="source_album").albumArtistIds=["album-artist"];}]){
    const events=structuredClone(original);change(events);const result=(await verify(plain(events)));
    assert.equal(result.status,1);assert.equal(result.ok,false);
  }
});
test("verifier refuses incomplete, repeated, non-audit, and malformed logs",async()=>{
  const events=audited().events();
  for(const bad of [events.slice(0,-1),events.filter(e=>e.event!=="source_album"),
    events.filter(e=>e.event!=="audit_config"),[...events,...events],
    [...events.slice(0,3),events.find(e=>e.event==="source_album"),...events.slice(3)]])assert.equal((await verify(plain(bad))).status,1);
  const result=(await verify('Automatic Ratings: {"schemaVersion":1,"event":'));assert.equal(result.status,1);
});
test("verifier requires matching/adopted targets and independently checks quota-failure counts",async()=>{
  const h=fixture();h.setRating("example-reader","album","album-a",5);
  h.run({audit_logging:true,album_rating_policy:"replace"});
  assert.equal((await verify(plain(h.events()))).status,0);
  const missing=structuredClone(h.events());missing.find(e=>e.action==="preview_adopt").proposedRating=null;
  assert.equal((await verify(plain(missing))).status,1);
  const quota=structuredClone(h.events());quota.find(e=>e.event==="user_summary").albums.quotaFailures++;
  quota.find(e=>e.event==="run_summary").albums.quotaFailures++;
  assert.equal((await verify(plain(quota))).status,1);
});
test("artist explanations trace collaboration credits once per song and can select one user",async()=>{
  const h=audited(),log=plain(h.events());
  const all=(await verify(log,["--explain-artist","collaborator"]));assert.equal(all.status,0);
  assert.equal(all.verifiedArtists,6);assert.equal(all.artistExplanations.length,2);
  const result=(await verify(log,["--explain-artist","collaborator","--user","example-reader"]));
  assert.equal(result.status,0);assert.equal(result.artistExplanations.length,1);
  const e=result.artistExplanations[0];assert.equal(e.attribution,"album_artist");
  assert.equal(e.totalSongs,1);assert.equal(e.calculatedRating,5);assert.equal(e.scoreExact,"5");
  assert.deepEqual(e.histogram,[0,0,0,0,0,1]);assert.equal(e.contributions.length,1);
  assert.equal(e.contributions[0].albumId,"album-a");
  assert.deepEqual(e.contributions[0].songs,[{id:"album-a-song-0",rating:5,artistIds:["album-artist","collaborator"]}]);
  const unrated=all.artistExplanations.find(e=>e.user==="example-unrated");
  assert.equal(unrated.calculatedRating,0);assert.equal(unrated.scoreExact,null);assert.equal(unrated.proposedRating,null);
});
test("artist explanations respect performing attribution and distinguish preserved values from calculated ones",async()=>{
  const performing=(await verify(plain(audited({artist_attribution:"performing_artist"}).events()),
    ["--explain-artist","guest-artist","--user","example-reader"]));
  assert.equal(performing.status,0);const e=performing.artistExplanations[0];
  assert.equal(e.attribution,"performing_artist");assert.equal(e.totalSongs,1);assert.equal(e.calculatedRating,1);
  assert.deepEqual(e.contributions[0].songs,[{id:"album-b-song-0",rating:1,artistIds:["guest-artist","performer-one"]}]);
  const h=fixture();h.setRating("example-reader","artist","album-artist",4);h.run({audit_logging:true});
  const preserved=(await verify(plain(h.events()),["--explain-artist","album-artist","--user","example-reader"]));
  assert.equal(preserved.status,0);const p=preserved.artistExplanations[0];
  assert.equal(p.calculatedRating,3);assert.equal(p.scoreExact,"29/9");
  assert.equal(p.existingRating,4);assert.equal(p.proposedRating,null);assert.equal(p.action,"preserve");
});
test("artist selection rejects missing IDs/users and still verifies unrelated source calculations",async()=>{
  const h=audited(),log=plain(h.events());
  for(const args of [["--explain-artist","missing"],["--explain-artist","collaborator","--user","missing"],
    ["--explain-artist","guest-artist"],["--user","example-reader"]]){
    const result=(await verify(log,args));assert.equal(result.status,1);assert.equal(result.ok,false);
  }
  const events=h.events();events.find(e=>e.event==="item"&&e.kind==="album"&&e.id==="album-b").score=4;
  assert.equal((await verify(plain(events),["--explain-artist","collaborator"])).status,1);
});
test("artist explanations refuse failed or blocked evaluations rather than presenting a partial result",async()=>{
  for(const blocked of [false,true]){
    const h=fixture();h.before=(name,request)=>{
      if(name==="subsonicapi_call"&&request.uri.startsWith(blocked?"getAlbum?":"getArtist?")&&
          request.uri.includes(blocked?"id=album-a&":"id=album-artist&"))return {error:"fictional source or target failure"};
    };
    h.run({audit_logging:true});
    const result=(await verify(plain(h.events()),["--explain-artist","album-artist","--user","example-reader"]));
    assert.equal(result.status,1);assert.equal(result.ok,false);
    assert.match(result.error,blocked?/Incomplete source/:/Failed or blocked/);
    assert.equal(Object.hasOwn(result,"artistExplanations"),false);
  }
});
test("independent audit verification reconstructs zero-weight scoring, coverage, and excluded-only skips",async()=>{
  const h=audited({album_one_star_weight:0,artist_one_star_weight:0});
  const result=(await verify(plain(h.events()),["--explain-artist","album-artist","--user","example-reader"]));
  assert.equal(result.status,0);const artist=result.artistExplanations[0];
  assert.equal(artist.totalSongs,5);assert.equal(artist.ratedSongs,5);assert.equal(artist.excludedSongs,4);
  assert.equal(artist.eligibleSongs,1);assert.equal(artist.contributingRatedSongs,1);assert.equal(artist.calculatedRating,5);
  assert.equal(artist.contributions.reduce((n,a)=>n+a.songs.length,0),5);
  assert.ok(h.events("item").some(e=>e.action==="skip_excluded"));
  const performing=audited({artist_one_star_weight:0,artist_attribution:"performing_artist"});
  assert.equal((await verify(plain(performing.events()),["--explain-artist","guest-artist"])).status,0);
});
test("audit verification rejects corrupt exclusion counts, incorrect skips, and all-zero weights",async()=>{
  const original=audited({album_one_star_weight:0,artist_one_star_weight:0}).events();
  for(const change of [events=>{events.find(e=>e.event==="item").excludedSongs++;},
    events=>{delete events.find(e=>e.event==="item").contributingRatedSongs;},
    events=>{const item=events.find(e=>e.action==="skip_excluded");item.action="skip_empty";},
    events=>{for(const star of ["one","two","three","four","five"])events.find(e=>e.event==="audit_config").settings[`artist_${star}_star_weight`]=0;}]){
    const events=structuredClone(original);change(events);assert.equal((await verify(plain(events))).status,1);
  }
});
test("audit verification supports scientific notation and legacy positive-weight item fields",async()=>{
  const h=audited({album_one_star_weight:1e-7,album_three_star_weight:3e-7});
  assert.equal((await verify(plain(h.events()))).status,0);
  const legacy=audited().events();
  for(const item of legacy.filter(e=>e.event==="item"))for(const field of ["excludedSongs","eligibleSongs","contributingRatedSongs"])delete item[field];
  assert.equal((await verify(plain(legacy))).status,0);
});
