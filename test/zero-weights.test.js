"use strict";
const test=require("node:test"),assert=require("node:assert/strict");
const {calculateRating,readSettings,signature,DEFAULTS,decideRating,ownerKey,encode,validCounts}=require("../src/plugin");
const {fixture}=require("./helpers");
const user="example-reader",withoutOnes=[0,2,3,4,5];
const settings=config=>readSettings(key=>config[key]);

test("zero weights exclude songs from scoring and coverage while retaining raw source counts",()=>{
  const result=calculateRating([3,7,0,0,0,2],{weights:withoutOnes});
  assert.equal(result.totalSongs,12);assert.equal(result.ratedSongs,9);assert.equal(result.unratedSongs,3);
  assert.equal(result.excludedSongs,7);assert.equal(result.eligibleSongs,5);assert.equal(result.contributingRatedSongs,2);
  assert.equal(result.requiredRatedSongs,2);assert.equal(result.meetsThreshold,true);assert.equal(result.rating,5);
  const minimum=calculateRating([3,7,0,0,0,2],{weights:withoutOnes,minimumRatedSongs:3});
  assert.equal(minimum.meetsThreshold,false);assert.equal(minimum.score,null);
});
test("unrated songs remain in the coverage denominator after filtering",()=>{
  const result=calculateRating([4,5,0,0,0,1],{weights:withoutOnes});
  assert.equal(result.eligibleSongs,5);assert.equal(result.contributingRatedSongs,1);
  assert.equal(result.requiredRatedSongs,2);assert.equal(result.meetsThreshold,false);
  assert.equal(calculateRating([4,5,0,0,0,1],{weights:withoutOnes,minimumRatedPercent:0}).rating,5);
});
test("any combination of zero-weight tiers can be excluded",()=>{
  const result=calculateRating([1,2,3,0,0,1],{weights:[0,0,3,4,5]});
  assert.equal(result.excludedSongs,5);assert.equal(result.eligibleSongs,2);
  assert.equal(result.contributingRatedSongs,1);assert.equal(result.requiredRatedSongs,1);assert.equal(result.rating,5);
  const positive=calculateRating([0,4,0,0,0,1],{weights:[0.1,2,3,4,5]});
  assert.equal(positive.excludedSongs,0);assert.equal(positive.eligibleSongs,5);assert.equal(positive.contributingRatedSongs,5);
  assert.equal(positive.rating,5);
});
test("filtering every rated song keeps existing ratings while genuinely unrated sources still follow clearing",()=>{
  const result=calculateRating([3,5,0,0,0,0],{weights:withoutOnes});
  assert.equal(result.score,null);assert.equal(result.rating,0);assert.equal(result.meetsThreshold,false);
  for(const policy of ["preserve","replace"])for(const clear of [true,false])for(const current of [0,3]){
    const decision=decideRating(result,current,null,policy,clear);
    assert.equal(decision.outcome,"empty");assert.equal(decision.action,"skip_excluded");
    assert.equal(decision.reason,"no_contributing_rated_songs");assert.equal(decision.target,null);
  }
  const unrated=calculateRating([4,0,0,0,0,0],{weights:withoutOnes});
  assert.equal(decideRating(unrated,4,null,"replace",true).target,0);
  assert.equal(decideRating(calculateRating([0,0,0,0,0,0],{weights:withoutOnes}),4,null,"replace",true).action,"skip_empty");
});
test("weights accept zero and small positive decimals but reject all-zero output configurations",()=>{
  assert.equal(settings({album_one_star_weight:"0"}).album_one_star_weight,0);
  assert.equal(settings({artist_one_star_weight:"1e-7"}).artist_one_star_weight,1e-7);
  assert.notEqual(signature(DEFAULTS),signature(settings({album_one_star_weight:0})));
  for(const kind of ["album","artist"]){
    const config=Object.fromEntries(["one","two","three","four","five"].map(star=>[`${kind}_${star}_star_weight`,0]));
    assert.throws(()=>settings(config),/positive/);
    assert.throws(()=>settings({...config,[`rate_${kind}s`]:false}),/positive/);
  }
  for(const weights of [[0,0,0,0,0],[-1,2,3,4,5],[0,2,3,4,11]])assert.throws(()=>calculateRating([0,1,0,0,0,0],{weights}));
});
test("small scientific-notation weights preserve exact half-up rounding and finite logged scores",()=>{
  const tie=calculateRating([0,1,0,1,0,0],{weights:[1e-7,0,3e-7,0,0]});
  assert.equal(tie.score,2.5);assert.equal(tie.rating,3);
  const mixed=calculateRating([0,1,0,0,0,1],{weights:[5e-324,0,0,0,1]});
  assert.ok(Number.isFinite(mixed.score));assert.equal(mixed.rating,5);
  const tiny=calculateRating([0,1,0,0,0,0],{weights:[5e-324,0,0,0,0]});
  assert.equal(tiny.score,1);assert.equal(tiny.rating,1);
});
test("album and artist exclusions are independent and never change song inputs",()=>{
  const h=fixture({users:[user]}),before=structuredClone(h.albums);
  h.run({dry_run:false,artist_one_star_weight:0});
  assert.equal(h.getRating(user,"album","album-b"),1);assert.equal(h.getRating(user,"artist","album-artist"),5);
  const items=h.events("item"),album=items.find(e=>e.kind==="album"&&e.id==="album-b");
  const artist=items.find(e=>e.kind==="artist"&&e.id==="album-artist");
  assert.equal(album.excludedSongs,0);assert.equal(artist.totalSongs,5);assert.equal(artist.excludedSongs,4);
  assert.equal(artist.eligibleSongs,1);assert.equal(artist.contributingRatedSongs,1);
  assert.deepEqual(h.albums,before);assert.equal(h.events("user_summary")[0].ratedSongs,6);
});
test("all-excluded owned and foreign ratings are skipped without clears, adoption, or quota failures",()=>{
  for(const owned of [true,false]){
    const h=fixture({users:[user]});h.setRating(user,"album","album-b",4);
    if(owned)h.storage.set(ownerKey(user,"album","album-b"),encode({version:1,rating:4,manual:false,pending:null}));
    h.run({dry_run:false,album_one_star_weight:0,artist_one_star_weight:0,album_rating_policy:"replace",artist_rating_policy:"replace"});
    assert.equal(h.getRating(user,"album","album-b"),4);assert.equal(h.writes.some(w=>w.id==="album-b"),false);
    const item=h.events("item").find(e=>e.id==="album-b"&&e.kind==="album");
    assert.equal(item.action,"skip_excluded");assert.equal(item.excludedSongs,4);assert.equal(item.proposedRating,null);
    const summary=h.events("run_summary")[0];assert.equal(summary.albums.empty,2);assert.equal(summary.albums.quotaFailures,1);
    assert.ok(validCounts(summary.albums));assert.ok(validCounts(summary.artists));
  }
});
test("excluded guest-only artists retain ratings in performing-artist mode",()=>{
  const h=fixture({users:[user]});h.setRating(user,"artist","guest-artist",4);
  h.run({dry_run:false,rate_albums:false,artist_attribution:"performing_artist",artist_one_star_weight:0,artist_rating_policy:"replace"});
  assert.equal(h.getRating(user,"artist","performer-one"),5);assert.equal(h.getRating(user,"artist","guest-artist"),4);
  const item=h.events("item").find(e=>e.id==="guest-artist");assert.equal(item.action,"skip_excluded");
  assert.equal(h.events("run_summary")[0].artists.quotaFailures,0);
});
test("eligible but insufficient coverage can still clear a managed value after exclusions",()=>{
  const h=fixture({users:[user]});h.albums[1].songs.forEach((song,i)=>{song.userRating=[1,5,0,0][i];});
  h.setRating(user,"album","album-b",4);
  h.run({dry_run:false,rate_artists:false,album_one_star_weight:0,album_minimum_rated_percent:50,album_rating_policy:"replace"});
  assert.equal(h.getRating(user,"album","album-b"),0);
  const item=h.events("item").find(e=>e.id==="album-b");assert.equal(item.action,"clear");
  assert.equal(item.eligibleSongs,3);assert.equal(item.contributingRatedSongs,1);assert.equal(item.requiredRatedSongs,2);
});
test("source validation includes excluded songs and still blocks unsafe artist writes",()=>{
  const h=fixture({users:[user]});h.after=(name,request,response)=>{
    if(name==="subsonicapi_call"&&request.uri.startsWith("getAlbum?")&&request.uri.includes("id=album-b&")){
      const body=JSON.parse(response.responseJson);body["subsonic-response"].album.song[0].userRating=null;
      return {responseJson:JSON.stringify(body)};
    }
  };
  h.run({dry_run:false,album_one_star_weight:0,artist_one_star_weight:0});
  assert.equal(h.writes.some(w=>w.kind==="artist"),false);assert.equal(h.events("user_summary")[0].sourceComplete,false);
});
