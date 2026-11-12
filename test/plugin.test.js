"use strict";
const test=require("node:test"),assert=require("node:assert/strict");
const {fixture:makeFixture,ref}=require("./helpers");
// Retain full-evaluation coverage for all original policies and safety paths.
// The fast-path suite separately exercises production defaults and fallbacks.
const fixture=options=>makeFixture({...options,configDefaults:{skip_unrated_users:false}});
const {validCounts,ownerKey,encode,decode}=require("../src/plugin");
const user="example-reader";
function counts(h){return h.events("user_summary").find(e=>e.user===user);}
function assertCounts(c){assert.ok(validCounts(c),JSON.stringify(c));}
function repeat(h,config){h.clock+=1000;const p=h.make(config);p.startRun();
  let result;let n=0;do{result=p.onSchedule({payload:"worker"});assert.ok(++n<1000);}while(result.active);return p;}
function bodyMutation(h,endpoint,mutate){h.after=(name,request,result)=>{
  if(name!=="subsonicapi_call"||!request.uri.startsWith(endpoint+"?"))return;
  const json=JSON.parse(result.responseJson);mutate(json["subsonic-response"],new URL(request.uri,"http://example.invalid"));
  return {responseJson:JSON.stringify(json)};
};}

test("both outputs use songs independently and dry run leaves ratings and ownership untouched",()=>{
  const h=fixture();h.run();
  assert.deepEqual(h.writes,[]);assert.equal(h.ratings.size,0);
  assert.equal([...h.storage.keys()].some(key=>key.includes("owner:")),false);
  const previews=h.events("item").filter(e=>e.user===user&&e.action==="preview_update");
  assert.equal(previews.find(e=>e.kind==="album"&&e.id==="album-a").proposedRating,5);
  assert.equal(previews.find(e=>e.kind==="album"&&e.id==="album-b").proposedRating,1);
  assert.equal(previews.find(e=>e.kind==="artist"&&e.id==="album-artist").proposedRating,3); // Album-based weighting would give 4.
  const c=counts(h);assert.equal(c.scannedSongs,9);assert.equal(c.albums.updated,2);assert.equal(c.albums.belowQuota,1);
  assert.equal(c.albums.empty,1);assert.equal(c.artists.updated,1);assert.equal(c.artists.belowQuota,1);
  for(const e of h.events("user_summary")){assertCounts(e.albums);assertCounts(e.artists);}
  const total=h.events("run_summary")[0];assertCounts(total.albums);assertCounts(total.artists);
  assert.equal(total.users,2);assert.equal(h.state().active,false);
});
test("users with no song ratings get info summaries and no per-item info flood by default",()=>{
  const h=fixture();h.run();const empty=h.events("user_summary").find(e=>e.user==="example-unrated");
  assert.equal(empty.albums.updated,0);assert.equal(empty.albums.belowQuota,3);assert.equal(empty.artists.belowQuota,2);
  assert.equal(h.logs.some(([level,line])=>level==="info"&&JSON.parse(line.slice(19)).event==="item"),false);
  assert.ok(h.logs.some(([level,line])=>level==="info"&&line.includes('"event":"user_summary"')));
});
test("detail logging can be promoted to info or disabled; item schema is stable across outcomes",()=>{
  const all=[];
  for(const detail_logging of ["debug","info","off"]){
    const h=fixture();h.setRating(user,"album","album-a",2);h.run({detail_logging});
    const items=h.events("item");
    if(detail_logging==="off")assert.equal(items.length,0);
    else{assert.ok(items.length>0);for(const e of items)all.push(Object.keys(e).sort());
      assert.ok(h.logs.filter(([,line])=>line.includes('"event":"item"')).every(([level])=>level===detail_logging));}
  }
  for(const keys of all)assert.deepEqual(keys,all[0]);
});
test("writes only album/artist IDs and keeps independent artist results even after album writes",()=>{
  const h=fixture();h.run({dry_run:false});
  assert.equal(h.getRating(user,"album","album-a"),5);assert.equal(h.getRating(user,"album","album-b"),1);
  assert.equal(h.getRating(user,"artist","album-artist"),3);assert.equal(h.writes.length,3);
  for(const w of h.writes)assert.ok(["album","artist"].includes(w.kind));
  for(const w of h.writes)assert.equal(decode(h.storage.get(ownerKey(w.user,w.kind,w.id))).rating,w.rating);
});
test("performing attribution includes guest-only artists even when getArtists would omit them",()=>{
  const h=fixture();h.run({artist_attribution:"performing_artist"});
  const items=h.events("item").filter(e=>e.kind==="artist"&&e.user===user);
  assert.ok(items.some(e=>e.id==="guest-artist"&&e.proposedRating===1));
  assert.ok(items.some(e=>e.id==="performer-one"));assert.equal(items.some(e=>e.id==="album-artist"),false);
  assert.equal(h.calls.some(c=>c.request.uri?.startsWith("getArtists?")),false);
});
test("collaborating album artists receive each song once per artist using structured IDs",()=>{
  const h=fixture();h.albums[0].artists.push(ref("second-album-artist"),ref("album-artist"));h.run();
  const items=h.events("item").filter(e=>e.kind==="artist"&&e.user===user);
  assert.equal(items.find(e=>e.id==="second-album-artist").totalSongs,1);
  assert.equal(items.find(e=>e.id==="album-artist").totalSongs,5);
});
test("album-only and artist-only outputs remain independent",()=>{
  for(const rate_albums of [false,true]){
    const h=fixture();h.run({dry_run:false,rate_albums,rate_artists:!rate_albums});
    assert.ok(h.writes.length>0);assert.ok(h.writes.every(w=>w.kind===(rate_albums?"album":"artist")));
    const c=counts(h);assert.equal(c[rate_albums?"artists":"albums"].processed,0);
  }
});
test("preserve policies protect preexisting ratings separately while generated ratings keep converging",()=>{
  const h=fixture();h.setRating(user,"album","album-a",2);h.setRating(user,"artist","album-artist",4);
  const config={dry_run:false};h.run(config);
  assert.equal(h.getRating(user,"album","album-a"),2);assert.equal(h.getRating(user,"artist","album-artist"),4);
  assert.equal(h.getRating(user,"album","album-b"),1);
  for(const song of h.albums[1].songs)song.userRating=5;
  repeat(h,config);assert.equal(h.getRating(user,"album","album-b"),5);
  assert.equal(h.getRating(user,"artist","album-artist"),4);
});
test("replace can independently overwrite album or artist ratings without an initial wipe",()=>{
  for(const kind of ["album","artist"]){
    const h=fixture();h.setRating(user,"album","album-a",2);h.setRating(user,"artist","album-artist",4);
    h.run({dry_run:false,[`${kind}_rating_policy`]:"replace"});
    assert.equal(h.getRating(user,"album","album-a"),kind==="album"?5:2);
    assert.equal(h.getRating(user,"artist","album-artist"),kind==="artist"?3:4);
    assert.equal(h.writes.some(w=>w.id==="album-empty"),false);
  }
});
test("replace explicitly adopts matching existing ratings, including in a zero-write migration",()=>{
  const h=fixture();h.setRating(user,"album","album-a",5);
  h.run({dry_run:false,album_rating_policy:"replace"});
  assert.equal(h.writes.some(w=>w.id==="album-a"),false);
  assert.equal(decode(h.storage.get(ownerKey(user,"album","album-a"))).rating,5);
  assert.equal(counts(h).albums.adopted,1);
  h.albums[0].songs[0].userRating=2;
  repeat(h,{dry_run:false});assert.equal(h.getRating(user,"album","album-a"),2);
});
test("observed manual edits, including clearing to zero, are sticky overrides in preserve mode",()=>{
  for(const manual of [0,2]){
    const h=fixture(),config={dry_run:false};h.run(config);h.setRating(user,"album","album-a",manual);
    repeat(h,config);assert.equal(h.getRating(user,"album","album-a"),manual);
    assert.equal(decode(h.storage.get(ownerKey(user,"album","album-a"))).manual,true);
    repeat(h,config);assert.equal(h.getRating(user,"album","album-a"),manual);
    repeat(h,{dry_run:false,album_rating_policy:"replace"});assert.equal(h.getRating(user,"album","album-a"),5);
  }
});
test("below-quota clears are previewed, verified when written, and counted without overlap",()=>{
  for(const dry_run of [true,false])for(const clear of [true,false]){
    const h=fixture();h.setRating(user,"album","album-low",4);h.setRating(user,"artist","low-artist",4);
    h.run({dry_run,album_rating_policy:"replace",artist_rating_policy:"replace",
      album_clear_below_threshold:clear,artist_clear_below_threshold:clear});
    for(const [kind,id]of[["album","album-low"],["artist","low-artist"]]){
      assert.equal(h.getRating(user,kind,id),clear&&!dry_run?0:4);
      const c=counts(h)[kind+"s"];assert.equal(c.quotaFailures,1);assert.equal(c.cleared,clear?1:0);
      assert.equal(c.belowQuota,clear?0:1);assertCounts(c);
      const item=h.events("item").find(e=>e.user===user&&e.kind===kind&&e.id===id);
      assert.equal(item.action,clear?(dry_run?"preview_clear":"clear"):"keep_below_quota");
    }
  }
});
test("removing song ratings clears generated outputs but never a manual rating in preserve mode",()=>{
  const h=fixture(),config={dry_run:false};h.run(config);
  for(const album of h.albums)for(const song of album.songs)song.userRating=0;
  h.setRating(user,"artist","low-artist",5);repeat(h,config);
  assert.equal(h.getRating(user,"album","album-a"),0);assert.equal(h.getRating(user,"album","album-b"),0);
  assert.equal(h.getRating(user,"artist","album-artist"),0);assert.equal(h.getRating(user,"artist","low-artist"),5);
});
test("incomplete album data prevents that album from being overwritten and blocks all artist writes",()=>{
  const h=fixture();h.setRating(user,"album","album-a",2);h.setRating(user,"artist","album-artist",5);
  bodyMutation(h,"getAlbum",body=>{if(body.album.id==="album-a")body.album.songCount++;});
  h.run({dry_run:false,album_rating_policy:"replace",artist_rating_policy:"replace"});
  assert.equal(h.getRating(user,"album","album-a"),2);assert.equal(h.getRating(user,"artist","album-artist"),5);
  assert.equal(h.writes.some(w=>w.kind==="artist"),false);assert.equal(h.getRating(user,"album","album-b"),1);
  assert.equal(counts(h).sourceComplete,false);assert.ok(counts(h).sourceErrors>0);
});
test("invalid song ratings and duplicate song IDs never trigger destructive clearing",()=>{
  for(const mutate of [a=>{a.song[0].userRating=null;},a=>{a.song[1].id=a.song[0].id;},
    a=>{delete a.song[0].albumId;},a=>{a.song.pop();},a=>{a.songCount=-1;}]){
    const h=fixture();h.setRating(user,"album","album-b",5);h.setRating(user,"artist","album-artist",5);
    bodyMutation(h,"getAlbum",body=>{if(body.album.id==="album-b")mutate(body.album);});
    h.run({dry_run:false,album_rating_policy:"replace",artist_rating_policy:"replace"});
    assert.equal(h.getRating(user,"album","album-b"),5);assert.equal(h.writes.some(w=>w.kind==="artist"),false);
  }
});
test("missing performing credits blocks artist writes while valid album updates remain possible",()=>{
  const h=fixture();delete h.albums[0].songs[0].artists;
  h.before=(name,request)=>{if(name==="subsonicapi_call"&&request.uri.startsWith("getArtist?"))throw Error("Artist stage must be blocked");};
  h.run({dry_run:false,artist_attribution:"performing_artist"});
  assert.equal(h.getRating(user,"album","album-a"),5);assert.equal(h.writes.some(w=>w.kind==="artist"),false);
  assert.equal(counts(h).sourceComplete,false);
});
test("a failed album rating write does not contaminate independent song-based artist calculations",()=>{
  const h=fixture();h.before=(name,request)=>{
    if(name==="subsonicapi_call"&&request.uri.startsWith("setRating?")&&request.uri.includes("id=album-a&"))return {error:"simulated write failure"};
  };
  h.run({dry_run:false});assert.equal(counts(h).albums.failed,1);
  assert.equal(h.getRating(user,"artist","album-artist"),3);assert.equal(counts(h).sourceComplete,true);
});
test("source song changes during verification defer every artist rating update",()=>{
  const h=fixture();let albumReads=0;
  h.before=(name,request)=>{
    if(name==="subsonicapi_call"&&request.uri.startsWith("getAlbum?")&&request.uri.includes("id=album-a&")){
      if(++albumReads===2)h.albums[0].songs[0].userRating=1; // Dry run's fresh pre-write read detects this.
    }
  };
  h.run();assert.equal(counts(h).sourceComplete,false);
  assert.equal(h.events("item").some(e=>e.kind==="artist"&&e.action==="preview_update"),false);
});
test("inventory changes and duplicate pages fail closed for artist writes",()=>{
  const h=fixture();let inventories=0;
  h.before=(name,request)=>{
    if(name==="subsonicapi_call"&&request.uri.startsWith("getAlbumList2?")&&request.uri.includes("offset=0&")){
      if(++inventories===2)h.albums=h.albums.filter(a=>a.id!=="album-a");
    }
  };
  h.run({dry_run:false});assert.equal(h.writes.some(w=>w.kind==="artist"),false);assert.equal(counts(h).sourceComplete,false);
});
test("pagination tolerates a server page cap and checks an explicit terminal empty page",()=>{
  const h=fixture({pageCap:2});h.run();assert.equal(counts(h).albums.processed,4);
  const offsets=h.calls.filter(c=>c.request.uri?.startsWith("getAlbumList2?")).map(c=>new URL(c.request.uri,"http://example.invalid").searchParams.get("offset"));
  assert.ok(offsets.includes("4"));assert.ok(offsets.includes("2"));
});
test("only the intersection of plugin library grants and user access is scanned",()=>{
  const h=fixture();h.run({dry_run:false});assert.equal(h.writes.some(w=>w.id==="album-outside"),false);
  const h2=fixture({grants:[1,2],folders:[1]});h2.run();assert.equal(counts(h2).scannedSongs,9);
  const h3=fixture({grants:[2],folders:[1,2]});h3.run();assert.equal(counts(h3).albums.processed,1);
  assert.equal(h3.events("item").some(e=>e.id==="album-a"),false);
});
test("no library or user grants and disabled outputs cannot begin a scan",()=>{
  for(const options of [{grants:[]},{users:[]}]){const h=fixture(options);h.run({dry_run:false});assert.deepEqual(h.writes,[]);
    assert.ok(h.events("run_skipped").length>0);}
  const h=fixture();h.run({rate_albums:false,rate_artists:false,dry_run:false});assert.deepEqual(h.writes,[]);
});
test("empty inventories and inaccessible user scopes emit summaries and actionable warnings",()=>{
  for(const options of [{albums:[]},{folders:[]}]){const h=fixture(options);h.run();
    assert.equal(h.events("user_summary").length,2);assert.equal(counts(h).albums.processed,0);assert.deepEqual(h.writes,[]);
    assert.ok(h.events().some(e=>["empty_scope","empty_inventory"].includes(e.event)));}
});
test("an active library scan prevents source processing and rating writes",()=>{
  const h=fixture({scanning:true});const p=h.make({dry_run:false});p.initialize();p.startRun();
  assert.throws(()=>p.onSchedule({payload:"worker"}),/scanner/);assert.deepEqual(h.writes,[]);
  assert.equal(h.schedules.has("automatic-ratings-worker"),true);
});
test("manual requests are latched across fresh callback instances and actual scheduler restart",()=>{
  const h=fixture(),config={run_now:true};let p=h.make(config);p.initialize();p.onSchedule({payload:"worker"});
  assert.equal(h.events("run_summary").length,1);p=h.make(config);
  assert.equal(p.onSchedule({payload:"worker"}).waiting,true);
  h.schedules.clear();p=h.make(config);p.initialize();assert.equal(p.onSchedule({payload:"worker"}).waiting,true);
  config.run_now=false;p.onSchedule({payload:"worker"});config.run_now=true;p.onSchedule({payload:"worker"});
  assert.equal(h.events("run_summary").length,2);assert.deepEqual(h.writes,[]);
});
test("daily requests queue work, coalesce with active scans, and cannot cross safety changes",()=>{
  const h=fixture(),config={batch_size:1};const p=h.make(config);p.initialize();
  assert.deepEqual(p.onSchedule({payload:"daily"}),{requested:true});assert.equal(h.events("run_started").length,0);
  config.dry_run=false;assert.equal(p.onSchedule({payload:"worker"}).waiting,true);assert.deepEqual(h.writes,[]);
  h.clock++;p.onSchedule({payload:"daily"});p.onSchedule({payload:"worker"});assert.equal(h.events("run_summary").length,1);
});
test("one time budget spans chained batches and restart resumes both cursor and counters",()=>{
  const h=fixture(),config={dry_run:false,batch_size:1};
  h.before=(name,request)=>{if(name==="subsonicapi_call"&&request.uri.startsWith("getAlbum?"))h.clock+=2500;};
  let p=h.make(config);p.initialize();p.startRun();const first=p.onSchedule({payload:"worker"});
  assert.equal(first.active,true);assert.ok(h.clock>=21000);assert.equal(h.events("run_summary").length,0);
  const progress=h.events("run_progress")[0];assert.ok(progress.units>0);assert.ok(progress.callbackMs>=20000);
  assert.equal(progress.users,2);assert.ok(progress.scannedAlbums<=progress.totalAlbums);
  h.schedules.clear();p=h.make(config);p.initialize();let n=0;
  while(p.onSchedule({payload:"worker"}).active)assert.ok(++n<50);
  const total=h.events("run_summary")[0];assert.equal(total.albums.processed,8);assert.equal(total.artists.processed,4);
  assertCounts(total.albums);assertCounts(total.artists);assert.equal(h.writes.length,3);
});
test("configuration changes during work cancel the scan before write mode is applied",()=>{
  const h=fixture(),config={batch_size:1,run_now:true};let changed=false;
  h.after=(name,request,result)=>{
    if(!changed&&name==="subsonicapi_call"&&request.uri.startsWith("getAlbum?")){changed=true;config.dry_run=false;}
  };
  const p=h.make(config);p.initialize();p.onSchedule({payload:"worker"});
  assert.deepEqual(h.writes,[]);assert.equal(h.state().active,false);assert.ok(h.events("run_cancelled").length>0);
  assert.equal(p.onSchedule({payload:"worker"}).waiting,true);
});
test("changes to user grants, library grants or user library access cancel an interrupted run",()=>{
  for(const mutate of [h=>h.users.pop(),h=>h.grants.push(2),h=>h.folders=[]]){
    const h=fixture(),p=h.make({batch_size:1,dry_run:false});p.initialize();p.startRun();p.refresh();
    mutate(h);assert.equal(p.onSchedule({payload:"worker"}).cancelled,true);assert.deepEqual(h.writes,[]);
  }
});
test("parallel worker callbacks cannot process the same cursor and the timer is always rearmed",()=>{
  const h=fixture(),config={run_now:true};let nested=false;
  h.before=(name,request)=>{
    if(!nested&&name==="subsonicapi_call"&&request.uri.startsWith("getAlbum?")){
      nested=true;assert.equal(h.schedules.has("automatic-ratings-worker"),false);
      assert.deepEqual(h.make(config).onSchedule({payload:"worker"}),{busy:true});
    }
  };
  const p=h.make(config);p.initialize();p.onSchedule({payload:"worker"});
  assert.equal(h.events("run_summary").length,1);assert.equal(h.schedules.size,2);
});
test("worker timer is rearmed after ordinary host failures",()=>{
  const h=fixture(),p=h.make({run_now:true});p.initialize();
  h.before=(name)=>name==="users_getusers"?{error:"backend unavailable"}:undefined;
  assert.throws(()=>p.onSchedule({payload:"worker"}),/backend unavailable/);
  assert.equal(h.schedules.has("automatic-ratings-worker"),true);
});
test("live callbacks can update daily schedules and continuation intervals without duplicate IDs",()=>{
  const h=fixture(),config={};const p=h.make(config);p.initialize();
  config.run_time_utc="18:42";config.batch_interval_seconds=15;
  p.onSchedule({payload:"worker"});assert.equal(h.schedules.get("automatic-ratings-daily").cronExpression,"CRON_TZ=UTC 42 18 * * *");
  assert.equal(h.schedules.get("automatic-ratings-worker").cronExpression,"@every 15s");
});
test("a lost write response is recovered from a pending intent without another write",()=>{
  const h=fixture(),config={dry_run:false};let fail=true;
  h.after=(name,request,result)=>{
    if(fail&&name==="subsonicapi_call"&&request.uri.startsWith("setRating?")&&request.uri.includes("id=album-a&")){
      fail=false;return {error:"response lost after successful write"};
    }
  };
  h.run(config);const key=ownerKey(user,"album","album-a");assert.ok(decode(h.storage.get(key)).pending);
  const before=h.writes.filter(w=>w.user===user&&w.id==="album-a").length;
  repeat(h,config);assert.equal(decode(h.storage.get(key)).pending,null);
  assert.equal(decode(h.storage.get(key)).rating,5);
  assert.equal(h.writes.filter(w=>w.user===user&&w.id==="album-a").length,before);
});
test("an unverified write retains its intent and does not count as a successful update",()=>{
  const h=fixture();h.before=(name,request)=>{
    if(name==="subsonicapi_call"&&request.uri.startsWith("setRating?")&&request.uri.includes("id=album-a&"))return h.envelope({});
  };
  h.run({dry_run:false});assert.equal(counts(h).albums.failed,1);
  assert.equal(decode(h.storage.get(ownerKey(user,"album","album-a"))).pending.target,5);
});
test("ownership storage failure occurs before rating writes",()=>{
  const h=fixture();h.before=(name,request)=>name==="kvstore_set"&&request.key.includes("owner:")?{error:"storage quota exceeded"}:undefined;
  h.run({dry_run:false});assert.deepEqual(h.writes,[]);assert.ok(counts(h).albums.failed>0);assert.ok(counts(h).artists.failed>0);
});
test("ownership finalization failure retains the intent and recovers without repeating a successful write",()=>{
  const h=fixture(),config={dry_run:false},key=ownerKey(user,"album","album-a");let failed=false;
  h.before=(name,request)=>{
    if(!failed&&name==="kvstore_set"&&request.key===key&&decode(request.value).pending===null&&h.getRating(user,"album","album-a")===5){
      failed=true;return {error:"fictional finalization failure"};
    }
  };
  h.run(config);assert.equal(failed,true);assert.equal(counts(h).albums.failed,1);
  assert.equal(decode(h.storage.get(key)).pending.target,5);
  const writes=h.writes.filter(w=>w.user===user&&w.id==="album-a").length;
  repeat(h,config);assert.equal(decode(h.storage.get(key)).pending,null);
  assert.equal(decode(h.storage.get(key)).rating,5);
  assert.equal(h.writes.filter(w=>w.user===user&&w.id==="album-a").length,writes);
});
test("artist-only source failures do not emit uncounted album item events",()=>{
  const h=fixture({users:[user]});h.before=(name,request)=>{
    if(name==="subsonicapi_call"&&request.uri.startsWith("getAlbum?")&&request.uri.includes("id=album-a&"))return {error:"fictional source failure"};
  };
  h.run({rate_albums:false,dry_run:false,detail_logging:"info"});
  assert.equal(counts(h).albums.processed,0);assert.equal(h.events("item").filter(e=>e.kind==="album").length,0);
  assert.equal(h.events("source_album_failed").length,1);assert.equal(counts(h).sourceErrors,1);
  assert.deepEqual(h.writes,[]);
});
test("blocked artist failures remain visible when routine item logging is off",()=>{
  const h=fixture({users:[user]});bodyMutation(h,"getAlbum",body=>{if(body.album.id==="album-a")body.album.songCount++;});
  h.run({dry_run:false,detail_logging:"off"});
  const blocked=h.logs.filter(([,line])=>JSON.parse(line.slice(19)).action==="blocked");
  assert.equal(blocked.length,counts(h).artists.failed);assert.ok(blocked.length>0);
  assert.ok(blocked.every(([level])=>level==="error"));
  assert.equal(h.writes.some(w=>w.kind==="artist"),false);
});
test("settings, access, and scanner changes while persisting a write intent defer the rating write",()=>{
  for(const kind of ["album","artist"])for(const change of [(h,config)=>{config.dry_run=true;},h=>{h.folders=[];},h=>{h.scanning=true;}]){
    const h=fixture({users:[user]}),config={dry_run:false,rate_albums:kind==="album",rate_artists:kind==="artist"};
    const key=ownerKey(user,kind,kind==="album"?"album-a":"album-artist");let changed=false;
    h.after=(name,request)=>{
      if(!changed&&name==="kvstore_set"&&request.key===key&&decode(request.value).pending){changed=true;change(h,config);}
    };
    h.run(config);assert.equal(changed,true);assert.deepEqual(h.writes,[]);
    assert.equal(decode(h.storage.get(key)).pending.target,kind==="album"?5:3);
  }
});
test("corrupt ownership protects the affected rating even in replace mode",()=>{
  const h=fixture();h.setRating(user,"album","album-a",2);h.storage.set(ownerKey(user,"album","album-a"),encode({broken:true}));
  h.run({dry_run:false,album_rating_policy:"replace"});assert.equal(h.getRating(user,"album","album-a"),2);
  assert.ok(h.events("item").some(e=>e.id==="album-a"&&e.error?.includes("Corrupt ownership")));
});
test("corrupt scan state waits for a new request rather than continuing writes",()=>{
  const h=fixture();h.storage.set("automatic-ratings:v1:scan",encode({active:true}));
  const p=h.make({dry_run:false});p.initialize();assert.equal(p.onSchedule({payload:"worker"}).waiting,true);
  assert.deepEqual(h.writes,[]);assert.equal(h.events("state_reset").length,1);
});
test("non-Navidrome responses and malformed inventories never produce rating writes",()=>{
  for(const mutate of [body=>{body.type="other";},body=>{body.openSubsonic=false;},body=>{delete body.albumList2;}]){
    const h=fixture();bodyMutation(h,"getAlbumList2",mutate);
    const p=h.make({dry_run:false});p.initialize();p.startRun();assert.throws(()=>p.onSchedule({payload:"worker"}));
    assert.deepEqual(h.writes,[]);
  }
});
test("bounded state capacity aborts before an incomplete artist source can be applied",()=>{
  const h=fixture();const p=h.make({dry_run:false},{maxStateBytes:1600});p.initialize();p.startRun();
  assert.throws(()=>p.onSchedule({payload:"worker"}),/state limit/);
  assert.equal(h.state().active,false);assert.equal(h.writes.some(w=>w.kind==="artist"),false);
  assert.ok(h.events("storage_limit").length>0);
});

test("a daily event received while processing is satisfied by the completed scan",()=>{
  const h=fixture(),config={run_now:true};let queued=false,p;
  h.before=(name,request)=>{
    if(!queued&&name==="subsonicapi_call"&&request.uri.startsWith("getAlbum?")){
      queued=true;h.clock++;p.onSchedule({payload:"daily"});h.clock++;
    }
  };
  p=h.make(config);p.initialize();p.onSchedule({payload:"worker"});h.clock++;
  assert.equal(p.onSchedule({payload:"worker"}).waiting,true);assert.equal(h.events("run_summary").length,1);
});
test("source attribution changes during verification block artists even when song ratings stay equal",()=>{
  const h=fixture();let n=0;
  h.before=(name,request)=>{
    if(name==="subsonicapi_call"&&request.uri.startsWith("getAlbum?")&&request.uri.includes("id=album-a&")&&++n===3){
      h.albums[0].artists=[ref("new-album-artist")];
    }
  };
  h.run({dry_run:false});assert.equal(h.writes.some(w=>w.kind==="artist"),false);assert.equal(counts(h).sourceComplete,false);
});
test("concurrent target edits are deferred rather than overwritten, including in replace mode",()=>{
  const h=fixture();let n=0;
  h.before=(name,request)=>{
    if(name==="subsonicapi_call"&&request.uri.startsWith("getAlbum?")&&request.uri.includes("id=album-a&")&&++n===2){
      h.setRating(user,"album","album-a",2);
    }
  };
  h.run({dry_run:false,album_rating_policy:"replace"});assert.equal(h.getRating(user,"album","album-a"),2);
  assert.ok(h.events("item").some(e=>e.id==="album-a"&&e.error?.includes("concurrently")));
});
test("synthetic multi-page library with unrated users remains quiet at info and reconciles",()=>{
  const h=fixture({pageCap:11});h.albums=[];
  for(let i=0;i<120;i++){
    const id=`fictional-album-${String(i).padStart(3,"0")}`,aid=`fictional-artist-${i%13}`;
    h.albums.push({id,name:`Fictional album ${i}`,libraryId:1,artists:[ref(aid)],
      songs:Array.from({length:7},(_,n)=>({id:`${id}-song-${n}`,albumId:id,userRating:(i+n)%6,artists:[ref(aid)]}))});
  }
  h.run({batch_size:7});
  for(const summary of h.events("user_summary")){
    assert.equal(summary.albums.processed,120);assert.equal(summary.artists.processed,13);
    assert.equal(summary.scannedSongs,840);assertCounts(summary.albums);assertCounts(summary.artists);
  }
  assert.equal(h.logs.filter(([level])=>level==="info").length,5); // enable, start, two users, final run.
  assert.equal(h.calls.some(c=>c.request.uri?.startsWith("setRating?")),false);
});

test("invalid nested checkpoints are rejected before any resumed target write",()=>{
  for(const mutate of [c=>{Object.values(c.groups)[0].histogram[0]=-1;},c=>{c.sources=[];},
    c=>{c.index=c.albums.length+1;},c=>{c.user="different-user";}]){
    const h=fixture(),config={dry_run:false,batch_size:1},p=h.make(config);p.initialize();p.startRun();
    let steps=0;while(!h.state().current?.index){p.refresh();assert.ok(++steps<20);}
    const before=h.writes.length,state=h.state();mutate(state.current);
    h.storage.set("automatic-ratings:v1:scan",encode(state));
    assert.equal(p.onSchedule({payload:"worker"}).waiting,true);
    assert.equal(h.writes.length,before);assert.ok(h.events("state_reset").length>0);
  }
});

test("chained batches load one snapshot and serialize only at checkpoints",()=>{
  const h=fixture(),original=JSON.stringify;
  let snapshots=0;
  JSON.stringify=function(value,...args){
    if(value?.version===3&&value.totals&&Array.isArray(value.users))snapshots++;
    return original.call(this,value,...args);
  };
  try{h.run({batch_size:1});}finally{JSON.stringify=original;}
  const stateCalls=h.calls.filter(c=>c.request.key==="automatic-ratings:v1:scan");
  const checkpoints=stateCalls.filter(c=>c.name==="kvstore_set").length;
  assert.equal(stateCalls.filter(c=>c.name==="kvstore_get").length,2); // request + callback.
  assert.ok(snapshots<=checkpoints+1,`${snapshots} full encodings for ${checkpoints} checkpoints`);
  assert.ok(checkpoints>10);
});
test("an unrated user avoids source rechecks while retaining item outcomes and summaries",()=>{
  const h=fixture({users:["example-unrated"]});h.run();
  const summary=h.events("user_summary")[0];
  assert.equal(summary.ratedSongs,0);assert.equal(summary.sourceVerified,false);
  assert.equal(summary.sourceVerifiedAt,null);assert.equal(summary.sourceComplete,true);
  assert.equal(summary.albums.processed,4);assert.equal(summary.artists.processed,2);
  assertCounts(summary.albums);assertCounts(summary.artists);
  assert.equal(h.calls.filter(c=>c.request.uri?.startsWith("getAlbum?")).length,4);
  assert.equal(h.calls.filter(c=>c.request.uri?.startsWith("getAlbumList2?")).length,2);
  assert.equal(h.events("user_unrated").length,1);assert.deepEqual(h.writes,[]);
});
test("unrated users still verify sources before clearing owned or replace-eligible artist ratings",()=>{
  for(const dry_run of [true,false])for(const artist_rating_policy of ["preserve","replace"]){
    const h=fixture({users:["example-unrated"]}),id="album-artist",u=h.users[0];
    h.setRating(u,"artist",id,4);
    if(artist_rating_policy==="preserve")h.storage.set(ownerKey(u,"artist",id),
      encode({version:1,rating:4,manual:false,pending:null}));
    h.run({dry_run,artist_rating_policy});
    const summary=h.events("user_summary")[0];
    assert.equal(summary.sourceVerified,true);assert.notEqual(summary.sourceVerifiedAt,null);
    assert.equal(summary.artists.processed,2);assert.equal(summary.artists.cleared,1);
    assert.equal(h.getRating(u,"artist",id),dry_run?4:0);assertCounts(summary.artists);
    assert.ok(h.calls.filter(c=>c.request.uri?.startsWith("getAlbumList2?")).length>=4);
  }
});
test("a newly rated song in an unrated source blocks a stale artist clear",()=>{
  const h=fixture({users:["example-unrated"]}),u=h.users[0];let reads=0;
  h.setRating(u,"artist","album-artist",4);
  h.storage.set(ownerKey(u,"artist","album-artist"),encode({version:1,rating:4,manual:false,pending:null}));
  h.before=(name,request)=>{
    if(name==="subsonicapi_call"&&request.uri.startsWith("getAlbum?")&&request.uri.includes("id=album-a&")&&++reads===2)
      h.trackRatings.set(JSON.stringify([u,"album-a-song-0"]),5);
  };
  h.run({dry_run:false});
  assert.equal(h.getRating(u,"artist","album-artist"),4);
  assert.equal(h.events("user_summary")[0].sourceComplete,false);
  assert.equal(h.writes.some(w=>w.kind==="artist"),false);
});
test("Unicode snapshot growth is bounded before rating writes, including song and credit additions",()=>{
  for(const part of ["inventory","songs","credits"]){
    const h=fixture({users:[user]});h.albums=h.albums.slice(0,1);
    if(part==="inventory")h.albums[0].name="漢".repeat(10000);
    if(part==="songs")h.albums[0].songs=Array.from({length:20},(_,n)=>({
      id:`${n}${"漢".repeat(900)}`,albumId:"album-a",userRating:5,artists:[ref("performer-one")]}));
    if(part==="credits")h.albums[0].artists=Array.from({length:20},(_,n)=>ref(`artist-${n}`,"漢".repeat(900)));
    const p=h.make({dry_run:false},{maxStateBytes:20000});p.initialize();p.startRun();
    assert.throws(()=>p.onSchedule({payload:"worker"}),/state limit/);
    assert.deepEqual(h.writes,[]);assert.equal(h.state().active,false);
  }
});
test("upgrading an old checkpoint discards partial calculations and retains ownership",()=>{
  const h=fixture(),key=ownerKey(user,"album","album-a"),value=encode({version:1,rating:5,manual:false,pending:null});
  h.storage.set(key,value);h.storage.set("automatic-ratings:v1:scan",encode({version:1,active:true}));
  const p=h.make({dry_run:false});p.initialize();assert.equal(p.onSchedule({payload:"worker"}).waiting,true);
  assert.equal(h.storage.get(key),value);assert.equal(h.state().version,3);assert.deepEqual(h.writes,[]);
  assert.equal(h.events("checkpoint_upgraded")[0].previousRunActive,true);
});
test("summary timestamps identify read-time ratings and the remaining post-verification race",()=>{
  const h=fixture({users:[user]});let editedAt=null;
  h.before=(name,request)=>{
    h.clock++;
    if(name==="subsonicapi_call"&&request.uri.startsWith("getArtist?")&&editedAt===null){
      editedAt=h.clock;h.albums[0].songs[0].userRating=1;
    }
  };
  h.run();const summary=counts(h),total=h.events("run_summary")[0];
  assert.equal(summary.ratingsAsOf,"per_album_read_time");assert.equal(summary.sourceVerified,true);
  assert.ok(summary.sourceReadStartedAt<=summary.sourceReadCompletedAt);
  assert.ok(summary.sourceReadCompletedAt<=summary.sourceVerifiedAt);assert.ok(summary.sourceVerifiedAt<editedAt);
  assert.equal(total.sourceReadStartedAt,summary.sourceReadStartedAt);
  assert.equal(total.sourceReadCompletedAt,summary.sourceReadCompletedAt);
  assert.equal(total.sourceVerifiedAt,summary.sourceVerifiedAt);
});
