"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),path=require("node:path");
const {spawnSync}=require("node:child_process");
const fs=require("node:fs"),os=require("node:os");
const {fixture,ref}=require("./helpers");
const verifier=path.resolve(__dirname,"../scripts/verify-audit.py");
function verify(input){const dir=fs.mkdtempSync(path.join(os.tmpdir(),"automatic-ratings-audit-"));
  try{const file=path.join(dir,"fixture.jsonl");fs.writeFileSync(file,input);
    const r=spawnSync("python3",[verifier,file],{encoding:"utf8",timeout:15000});
    if(r.error)throw r.error;assert.ok(r.stdout,r.stderr);return {status:r.status,...JSON.parse(r.stdout)};
  }finally{fs.rmSync(dir,{recursive:true,force:true});}}
function plain(events){return events.map(e=>JSON.stringify(e)).join("\n");}
function audited(config={}){const h=fixture();h.albums[0].artists.push(ref("collaborator"),ref("album-artist"));
  h.run({audit_logging:true,...config});return h;}

test("independent verifier reproduces both outputs and structured collaboration credits",()=>{
  const h=audited();const result=verify(plain(h.events()));
  assert.equal(result.status,0);assert.equal(result.ok,true);assert.equal(result.verifiedAlbums,8);
  assert.equal(result.verifiedArtists,6);assert.equal(result.sourceAlbums,8);
  const source=h.events("source_album")[0];assert.equal(source.albumArtistIds.length,3);
  assert.ok(h.logs.filter(([,line])=>line.includes('"event":"item"')).every(([level])=>level==="info"));
  assert.ok(h.events("user_summary").every(e=>e.skipped===false));
});
test("verifier accepts plain, prefixed, Navidrome JSON, and quoted Navidrome text logs",()=>{
  const h=audited(),events=h.events();
  for(const render of [e=>JSON.stringify(e),e=>"Automatic Ratings: "+JSON.stringify(e),
    e=>JSON.stringify({time:"example",level:"info",msg:"Automatic Ratings: "+JSON.stringify(e)}),
    e=>`time="example" level=info msg=${JSON.stringify("Automatic Ratings: "+JSON.stringify(e))} plugin=automatic-ratings`]){
    assert.equal(verify(events.map(render).join("\n")).status,0);
  }
});
test("independent verification supports performing credits, custom weights, clears, and single outputs",()=>{
  for(const config of [{artist_attribution:"performing_artist"},
    {album_one_star_weight:1.1,album_three_star_weight:3.3,artist_one_star_weight:1.1,artist_three_star_weight:3.3},
    {rate_albums:false},{rate_artists:false}])assert.equal(verify(plain(audited(config).events())).status,0);
  const h=fixture();h.setRating("example-reader","album","album-low",4);h.setRating("example-reader","artist","low-artist",4);
  h.run({audit_logging:true,album_rating_policy:"replace",artist_rating_policy:"replace"});
  assert.equal(verify(plain(h.events())).status,0);
});
test("verifier detects wrong scores, quotas, targets, and missing collaboration IDs",()=>{
  const original=audited().events();
  for(const change of [events=>{events.find(e=>e.event==="item"&&e.kind==="artist").score=1;},
    events=>{events.find(e=>e.event==="item").requiredRatedSongs++;},
    events=>{events.find(e=>e.event==="item"&&e.action==="preview_update").proposedRating=2;},
    events=>{events.find(e=>e.event==="source_album").albumArtistIds=["album-artist"];}]){
    const events=structuredClone(original);change(events);const result=verify(plain(events));
    assert.equal(result.status,1);assert.equal(result.ok,false);
  }
});
test("verifier refuses incomplete, repeated, non-audit, and malformed logs",()=>{
  const events=audited().events();
  for(const bad of [events.slice(0,-1),events.filter(e=>e.event!=="source_album"),
    events.filter(e=>e.event!=="audit_config"),[...events,...events],
    [...events.slice(0,3),events.find(e=>e.event==="source_album"),...events.slice(3)]])assert.equal(verify(plain(bad)).status,1);
  const result=verify('Automatic Ratings: {"schemaVersion":1,"event":');assert.equal(result.status,1);
});
test("verifier requires matching/adopted targets and independently checks quota-failure counts",()=>{
  const h=fixture();h.setRating("example-reader","album","album-a",5);
  h.run({audit_logging:true,album_rating_policy:"replace"});
  assert.equal(verify(plain(h.events())).status,0);
  const missing=structuredClone(h.events());missing.find(e=>e.action==="preview_adopt").proposedRating=null;
  assert.equal(verify(plain(missing)).status,1);
  const quota=structuredClone(h.events());quota.find(e=>e.event==="user_summary").albums.quotaFailures++;
  quota.find(e=>e.event==="run_summary").albums.quotaFailures++;
  assert.equal(verify(plain(quota)).status,1);
});
