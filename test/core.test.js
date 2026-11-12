"use strict";
const test=require("node:test"), assert=require("node:assert/strict");
const {DEFAULTS,VERSION,readSettings,signature,calculateRating,validateAlbum,attributedSongs,fingerprint,
  resolveOwner,decideRating,ownerKey,encode,decode}=require("../src/plugin");
const {fixture}=require("./helpers");
function hist(...stars){const h=[0,0,0,0,0,0];for(const s of stars)h[s]++;return h;}
test("weighted song mean, quota ceiling, unrated exclusion, and positive half-up ties",()=>{
  assert.equal(calculateRating(hist(1,3)).score,2.5);
  assert.equal(calculateRating(hist(1,3)).rating,3);
  assert.equal(calculateRating(hist(5,3)).score,4.25);
  const x=calculateRating(hist(5,5,0,0,0,0,0));
  assert.equal(x.requiredRatedSongs,3);assert.equal(x.meetsThreshold,false);assert.equal(x.rating,0);
  const y=calculateRating(hist(5,5,5,0,0,0,0,0,0,0));assert.equal(y.rating,5);assert.equal(y.totalSongs,10);
  assert.equal(calculateRating(hist(5,1),{weights:[1,1,1,1,1]}).rating,3);
});
test("both sample-size and percentage requirements apply, including zero percent",()=>{
  assert.equal(calculateRating(hist(0),{minimumRatedPercent:0}).meetsThreshold,false);
  assert.equal(calculateRating(hist(5),{minimumRatedSongs:2}).meetsThreshold,false);
  assert.equal(calculateRating(hist()).score,null);
});
test("fractional weights round exact half-stars up without promoting values below the tie",()=>{
  for(const [one,three]of[[1.1,3.3],[1.6,4.8],[2.2,6.6],[2.7,8.1],[2.9,8.7],[3.2,9.6]]){
    const r=calculateRating(hist(1,3),{weights:[one,1,three,1,1]});
    assert.equal(r.rating,3);assert.equal(r.score,2.5);
  }
  assert.equal(calculateRating(hist(1,3),{weights:[1.1,1,3.2999999999999994,1,1]}).rating,2);
  assert.equal(calculateRating(hist(1,3),{weights:[1.1,1,3.3000000000000007,1,1]}).rating,3);
  assert.equal(calculateRating([0,1000000000000000,0,2999999999999999,0,0],{weights:[1,1,1,1,1]}).rating,2);
});
test("invalid histograms, quotas and weights are rejected",()=>{
  for(const h of [null,[],[0,0,0,0,0,-1],[0,0,0,0,0,0.5],[0,0,0,0,0,Infinity]])assert.throws(()=>calculateRating(h));
  for(const options of [{minimumRatedSongs:0},{minimumRatedPercent:101},{minimumRatedPercent:3.5},
    {weights:[1,1,1,1,0]},{weights:[1,2,3]},{weights:[1,1,1,1,NaN]}])assert.throws(()=>calculateRating(hist(3),options));
});
test("settings defaults and signatures separate operational controls from calculation safety",()=>{
  assert.deepEqual(readSettings(()=>undefined),DEFAULTS);
  const read=data=>readSettings(key=>data[key]);
  assert.equal(read({dry_run:"false"}).dry_run,false);
  assert.equal(read({album_one_star_weight:"1.5"}).album_one_star_weight,1.5);
  for(const data of [{dry_run:"yes"},{run_now:1},{artist_attribution:"names"},{album_rating_policy:"wipe"},
    {run_time_utc:"24:00"},{batch_size:0},{batch_size:" "},{album_minimum_rated_percent:3.1},
    {artist_minimum_rated_songs:0},{artist_five_star_weight:Infinity}])assert.throws(()=>read(data));
  assert.equal(signature(read({})),signature(read({run_now:true,detail_logging:"off",run_time_utc:"18:00",batch_size:1})));
  for(const data of [{dry_run:false},{artist_attribution:"performing_artist"},{rate_albums:false},
    {album_rating_policy:"replace"},{artist_clear_below_threshold:false}])assert.notEqual(signature(read({})),signature(read(data)));
});
test("valid Navidrome unrated songs omit userRating, but invalid explicit ratings never become zero",()=>{
  const album={id:"a",songCount:1,userRating:0,song:[{id:"s",albumId:"a"}]};
  assert.deepEqual(validateAlbum(album,album).histogram,hist(0));
  for(const value of [null,"3",-1,6,undefined,NaN]){
    const bad=structuredClone(album);bad.song[0].userRating=value;
    assert.throws(()=>validateAlbum(bad,bad));
  }
  delete album.userRating;assert.throws(()=>validateAlbum(album,album));
});
test("incomplete, duplicate, or incorrectly grouped album songs are rejected",()=>{
  const base={id:"a",songCount:2,userRating:0,song:[{id:"one",albumId:"a",userRating:4},{id:"two",albumId:"a",userRating:2}]};
  for(const mutate of [a=>{a.songCount=3;},a=>{a.song.pop();},a=>{a.song[1].id="one";},
    a=>{a.song[0].albumId="other";},a=>{a.song[0].isDir=true;},a=>{delete a.song[0].id;},a=>{a.song=null;}]){
    const a=structuredClone(base);mutate(a);assert.throws(()=>validateAlbum(a,{id:"a",songCount:2}));
  }
});
test("structured credit IDs determine attribution and de-duplicate collaboration membership",()=>{
  const album={artists:[{id:"main",name:"Name, with & punctuation"},{id:"main",name:"Same"},{id:"other",name:"Other"}]};
  const songs=[{id:"s",userRating:4,artists:[{id:"guest",name:"Guest"},{id:"guest",name:"Guest"}]}];
  const a=attributedSongs(album,songs,DEFAULTS);assert.deepEqual(a[0].artists.map(a=>a.id),["main","other"]);
  const b=attributedSongs(album,songs,{...DEFAULTS,artist_attribution:"performing_artist"});
  assert.deepEqual(b[0].artists.map(a=>a.id),["guest"]);
  assert.notEqual(fingerprint(a),fingerprint(b));
  assert.throws(()=>attributedSongs({},songs,DEFAULTS),/credits/);
  assert.throws(()=>attributedSongs(album,[{id:"s",userRating:4}],{...DEFAULTS,artist_attribution:"performing_artist"}),/credits/);
  assert.deepEqual(attributedSongs({},songs,{...DEFAULTS,rate_artists:false})[0].artists,[]);
});
test("preserve mode protects unmanaged ratings and manual zero overrides but refreshes owned ratings",()=>{
  const x=calculateRating(hist(5));
  assert.equal(decideRating(x,2,null,"preserve",true).outcome,"preserved");
  assert.equal(decideRating(x,0,{manual:true,rating:null},"preserve",true).outcome,"preserved");
  assert.equal(decideRating(x,2,{manual:false,rating:2},"preserve",true).target,5);
  assert.equal(decideRating(x,2,null,"replace",true).target,5);
  assert.equal(decideRating(calculateRating(hist()),5,null,"replace",true).outcome,"empty");
});
test("clearing only occurs for eligible rated targets with validated below-quota sources",()=>{
  const x=calculateRating(hist(0));
  assert.equal(decideRating(x,4,null,"preserve",true).outcome,"preserved");
  assert.equal(decideRating(x,4,{manual:false,rating:4},"preserve",true).target,0);
  assert.equal(decideRating(x,4,null,"replace",false).outcome,"belowQuota");
  assert.equal(decideRating(x,4,null,"replace",true).action,"clear");
  assert.equal(decideRating(x,0,null,"replace",true).outcome,"belowQuota");
});
test("ownership write intents recover successful writes and protect divergent manual edits",()=>{
  const o={version:1,rating:2,manual:false,pending:{before:2,target:5}};
  assert.equal(resolveOwner(o,5).owner.rating,5);assert.equal(resolveOwner(o,5).recovered,true);
  assert.equal(resolveOwner(o,2).owner.rating,2);assert.equal(resolveOwner(o,2).owner.pending,null);
  assert.equal(resolveOwner(o,3).owner.manual,true);
  assert.equal(resolveOwner({...o,pending:null},0).owner.manual,true);
  assert.throws(()=>resolveOwner({rating:5},5),/Corrupt/);
});
test("state encoding supports Unicode and ownership keys enforce the host byte limit",()=>{
  const value={user:"Example 漢字",name:"Étoile ★"};assert.deepEqual(decode(encode(value)),value);
  assert.notEqual(ownerKey("one","album","id"),ownerKey("two","album","id"));
  assert.notEqual(ownerKey("one","artist","id"),ownerKey("one","album","id"));
  assert.throws(()=>ownerKey("x".repeat(256),"album","id"),/limit/);
});
test("manifest defaults, version, bounds, website and UI controls match runtime settings",()=>{
  const manifest=require("../manifest.json"),pkg=require("../package.json");
  assert.equal(VERSION,manifest.version);
  assert.equal(manifest.version,pkg.version);assert.ok(manifest.website.startsWith("https://github.com/"));
  assert.equal(manifest.permissions.library.filesystem,false);assert.equal(manifest.config.schema.additionalProperties,false);
  const properties=manifest.config.schema.properties;
  assert.deepEqual(Object.keys(properties).sort(),Object.keys(DEFAULTS).sort());
  for(const [key,value]of Object.entries(DEFAULTS))assert.deepEqual(properties[key].default,value,key);
  const controls=[];
  function visit(node){if(node.type==="Control")controls.push(node.scope.split("/").pop());for(const child of node.elements??[])visit(child);}
  visit(manifest.config.uiSchema);assert.deepEqual(controls.sort(),Object.keys(DEFAULTS).sort());
});
