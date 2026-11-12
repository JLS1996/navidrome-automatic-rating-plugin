"use strict";
const test=require("node:test"),assert=require("node:assert/strict");
const {fixture,ref}=require("./helpers");
const {ownerKey,encode,decode,validCounts}=require("../src/plugin");
const user="example-unrated";
const calls=(h,endpoint)=>h.calls.filter(c=>c.request.uri?.startsWith(endpoint+"?"));
const summary=h=>h.events("user_summary")[0];
function mutate(h,endpoint,change){h.after=(name,request,response)=>{
  if(name!=="subsonicapi_call"||!request.uri.startsWith(endpoint+"?"))return;
  const body=JSON.parse(response.responseJson);change(body["subsonic-response"],new URL(request.uri,"http://example.invalid"));
  return {responseJson:JSON.stringify(body)};
};}

test("default bulk preflight skips an unrated user without album or artist evaluations",()=>{
  const h=fixture({users:[user],pageCap:2});h.run();
  const s=summary(h);assert.equal(s.skipped,true);assert.equal(s.ratedSongs,0);assert.equal(s.scannedSongs,9);
  assert.equal(s.albums.processed,0);assert.equal(s.artists.processed,0);
  assert.ok(validCounts(s.albums));assert.ok(validCounts(s.artists));
  assert.equal(calls(h,"getAlbum").length,0);assert.equal(calls(h,"getArtist").length,0);
  assert.equal(h.events("item").length,0);assert.equal(h.events("user_skipped").length,1);
  assert.equal(s.ratingsAsOf,"per_song_page_read_time");assert.equal(s.sourceVerified,false);
  assert.equal(h.events("run_summary")[0].usersSkipped,1);assert.deepEqual(h.writes,[]);
  assert.ok(calls(h,"search3").some(c=>new URL(c.request.uri,"http://example.invalid").searchParams.get("songOffset")==="9"));
});
test("rated users fall back early and keep the same results alongside skipped users",()=>{
  const h=fixture();h.run();const [rated,unrated]=h.events("user_summary");
  assert.equal(rated.skipped,false);assert.equal(rated.albums.updated,2);assert.equal(rated.artists.updated,1);
  assert.equal(unrated.skipped,true);assert.equal(h.events("run_summary")[0].sourceReadMode,"mixed");
  assert.equal(calls(h,"search3").filter(c=>c.request.uri.includes("u=example-reader")).length,1);
});
test("owned and replace-eligible ratings force full validation and retain clear previews and writes",()=>{
  for(const dry_run of [true,false])for(const kind of ["album","artist"])for(const policy of ["preserve","replace"]){
    const h=fixture({users:[user]}),id=kind==="album"?"album-a":"album-artist";
    h.setRating(user,kind,id,4);
    if(policy==="preserve")h.storage.set(ownerKey(user,kind,id),encode({version:1,rating:4,manual:false,pending:null}));
    h.run({dry_run,[`${kind}_rating_policy`]:policy});
    assert.equal(summary(h).skipped,false);assert.equal(summary(h)[kind+"s"].cleared,1);
    assert.equal(h.getRating(user,kind,id),dry_run?4:0);
    if(kind==="artist")assert.equal(summary(h).sourceVerified,true);
    assert.ok(calls(h,"getAlbum").length>0);
  }
});
test("unmanaged ratings can be skipped, while ownership history retains full override handling",()=>{
  for(const manual of [false,true]){
    const h=fixture({users:[user]});h.setRating(user,"artist","album-artist",4);
    if(manual)h.storage.set(ownerKey(user,"artist","album-artist"),encode({version:1,rating:null,manual:true,pending:null}));
    const before=new Map(h.storage);h.run({dry_run:false});
    assert.equal(summary(h).skipped,!manual);assert.equal(h.getRating(user,"artist","album-artist"),4);
    for(const[key,value]of before)assert.equal(h.storage.get(key),value);
    assert.deepEqual(h.writes,[]);
  }
});
test("skipping cannot lose a newly observed manual zero or interrupted write evidence",()=>{
  const h=fixture({users:[user]}),key=ownerKey(user,"album","album-a");
  h.storage.set(key,encode({version:1,rating:5,manual:false,pending:null}));h.run({dry_run:false});
  assert.equal(summary(h).skipped,false);assert.equal(decode(h.storage.get(key)).manual,true);
  h.setRating(user,"album","album-a",5);h.trackRatings.set(JSON.stringify([user,"album-a-song-0"]),1);
  h.clock++;const p=h.make({dry_run:false});p.startRun();while(p.onSchedule({payload:"worker"}).active){}
  assert.equal(h.getRating(user,"album","album-a"),5);
  const h2=fixture({users:[user]});h2.storage.set(key,encode({version:1,rating:null,manual:false,pending:{before:0,target:5}}));
  h2.run({dry_run:false});assert.equal(summary(h2).skipped,false);assert.equal(decode(h2.storage.get(key)).pending,null);
});
test("ownership-list failures fall back, and disabled-output history does not block a skip",()=>{
  for(const response of [{error:"simulated failure"},{keys:null},{keys:["wrong-prefix"]}]){
    const h=fixture({users:[user]});h.before=(name)=>name==="kvstore_list"?response:undefined;h.run();
    assert.equal(summary(h).skipped,false);assert.equal(summary(h).sourceComplete,true);
  }
  const h=fixture({users:[user]});h.storage.set(ownerKey(user,"artist","album-artist"),encode({version:1,rating:4,manual:false,pending:null}));
  h.run({rate_artists:false});assert.equal(summary(h).skipped,true);
});
test("clearing-disabled outputs do not prevent a safe skip even under replace",()=>{
  const h=fixture({users:[user]});h.setRating(user,"album","album-a",4);h.setRating(user,"artist","album-artist",5);
  h.run({dry_run:false,album_rating_policy:"replace",artist_rating_policy:"replace",
    album_clear_below_threshold:false,artist_clear_below_threshold:false});
  assert.equal(summary(h).skipped,true);assert.deepEqual(h.writes,[]);
});
test("missing, malformed, duplicate, truncated, and out-of-scope bulk data falls back",()=>{
  for(const change of [body=>{delete body.searchResult3;},body=>{body.searchResult3.song.splice(0,1);},
    body=>{body.searchResult3.song[1].id=body.searchResult3.song[0].id;},
    body=>{body.searchResult3.song[0].albumId="outside";},body=>{body.searchResult3.song[0].userRating=null;},
    body=>{body.searchResult3.artist=[];},body=>{body.searchResult3.artist[0].userRating="0";}]){
    const h=fixture({users:[user]});let changed=false;
    mutate(h,"search3",body=>{if(!changed){changed=true;change(body);}});
    h.run();assert.equal(summary(h).skipped,false);assert.equal(summary(h).albums.processed,4);
    assert.ok(calls(h,"getAlbum").length>0);assert.deepEqual(h.writes,[]);
  }
});
test("missing inventory ratings or credits fall back to the ordinary source contract",()=>{
  for(const key of ["userRating","artists"]){
    const h=fixture({users:[user]});mutate(h,"getAlbumList2",body=>{
      for(const a of body.albumList2.album)delete a[key];
    });
    h.run();assert.equal(summary(h).skipped,false);assert.equal(summary(h).sourceComplete,true);
  }
});
test("performing-artist preflight includes guest-only targets and cannot skip their clears",()=>{
  const h=fixture({users:[user]});h.setRating(user,"artist","guest-artist",4);
  h.run({dry_run:false,artist_attribution:"performing_artist",artist_rating_policy:"replace"});
  assert.equal(summary(h).skipped,false);assert.equal(h.getRating(user,"artist","guest-artist"),0);
  const h2=fixture({users:[user]});h2.run({artist_attribution:"performing_artist"});assert.equal(summary(h2).skipped,true);
});
test("corrupt ownership prevents a skip and stays protected during the ordinary pass",()=>{
  const h=fixture({users:[user]});h.setRating(user,"artist","album-artist",4);
  h.storage.set(ownerKey(user,"artist","album-artist"),encode({invalid:true}));h.run({dry_run:false});
  assert.equal(summary(h).skipped,false);assert.equal(summary(h).artists.failed,1);
  assert.equal(h.getRating(user,"artist","album-artist"),4);
});
test("inventory changes after the bulk proof trigger a full scan with the newer inventory",()=>{
  const h=fixture({users:[user]});let inventories=0;
  h.before=(name,request)=>{
    if(name==="subsonicapi_call"&&request.uri.startsWith("getAlbumList2?")&&request.uri.includes("offset=0&")&&++inventories===2)
      h.setRating(user,"album","album-a",4);
  };
  h.run({dry_run:false,album_rating_policy:"replace"});
  assert.equal(summary(h).skipped,false);assert.equal(h.getRating(user,"album","album-a"),0);
});
test("bulk reads intersect library grants and user access, including artists shared across libraries",()=>{
  const h=fixture({users:[user],grants:[1,2],folders:[1,2],pageCap:2});
  h.albums[4].artists.push(ref("album-artist"));h.run();
  assert.equal(summary(h).skipped,true);assert.equal(summary(h).scannedSongs,11);
  const h2=fixture({users:[user],grants:[1,2],folders:[1]});h2.run();
  assert.equal(summary(h2).scannedSongs,9);assert.ok(calls(h2,"search3").every(c=>c.request.uri.includes("musicFolderId=1&")));
});
test("preflight checkpoints resume across callbacks and still cancel changed access",()=>{
  const h=fixture({users:[user],pageCap:2}),config={batch_size:1};
  let p=h.make(config);p.initialize();p.startRun();let n=0;
  while(h.state().current?.phase!=="preflight"){p.refresh();assert.ok(++n<20);}
  p.refresh();const offset=h.state().current.preflight.songOffset;assert.ok(offset>0);
  p=h.make(config);while(p.refresh().active)assert.ok(++n<100);
  assert.equal(summary(h).skipped,true);assert.equal(calls(h,"getAlbum").length,0);
  const h2=fixture({users:[user]}),p2=h2.make(config);p2.initialize();p2.startRun();p2.refresh();
  h2.folders=[];assert.equal(p2.refresh().cancelled,true);assert.equal(h2.events("user_skipped").length,0);
});
test("audit logging and the fast-path switch retain full per-item scans",()=>{
  for(const config of [{audit_logging:true},{skip_unrated_users:false}]){
    const h=fixture({users:[user]});h.run(config);assert.equal(summary(h).skipped,false);
    assert.equal(summary(h).albums.processed,4);assert.equal(calls(h,"search3").length,0);
  }
});
test("snapshot telemetry retains the active peak after completion and across fresh callbacks",()=>{
  const h=fixture({pageCap:2});h.before=(name)=>{if(name==="subsonicapi_call")h.clock+=1000;};
  h.run({batch_size:1});const metric=decode(h.storage.get("automatic-ratings:v1:snapshot-metrics"));
  const bytes=Buffer.from(h.storage.get("automatic-ratings:v1:scan"),"base64").length;
  assert.equal(metric.snapshotBytes,bytes);assert.ok(metric.peakSnapshotBytes>bytes);
  assert.ok(metric.peakReservedBytes>=metric.peakSnapshotBytes);
  assert.equal(h.events("run_summary")[0].peakSnapshotBytes,metric.peakSnapshotBytes);
  assert.ok(h.events("run_progress").every(e=>e.snapshotLimitBytes===24*1024*1024));
});
test("bulk state capacity aborts before an uncheckpointable proof can be used",()=>{
  const h=fixture({users:[user]});h.albums[0].songs=Array.from({length:20},(_,n)=>({
    id:`${n}${"漢".repeat(900)}`,albumId:"album-a",userRating:0,artists:[ref("performer-one")]}));
  const p=h.make({dry_run:false},{maxStateBytes:20000});p.initialize();p.startRun();
  assert.throws(()=>p.onSchedule({payload:"worker"}),/state limit/);
  assert.deepEqual(h.writes,[]);assert.equal(h.events("user_skipped").length,0);assert.equal(h.state().active,false);
});
