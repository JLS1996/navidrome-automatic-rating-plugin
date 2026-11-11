"use strict";
const { createPlugin, decode } = require("../src/plugin");
const ref = (id, name = `Example ${id}`) => ({id, name});
function fixture(options = {}) {
  const makeAlbum = (id, libraryId, artistId, values) => ({id, name:`Example ${id}`, libraryId,
    artists:[ref(artistId)], songs:values.map((value, n) => ({id:`${id}-song-${n}`, albumId:id,
      title:`Example song ${n}`, userRating:value, artists:[ref("performer-one")], albumArtists:[ref(artistId)]}))});
  const albums = [makeAlbum("album-a",1,"album-artist",[5]), makeAlbum("album-b",1,"album-artist",[1,1,1,1]),
    makeAlbum("album-empty",1,"empty-artist",[]), makeAlbum("album-low",1,"low-artist",[5,0,0,0]),
    makeAlbum("album-outside",2,"outside-artist",[4,4])];
  albums[1].songs[0].artists.push(ref("guest-artist"));
  const h = {albums, users:["example-reader","example-unrated"], grants:[1], folders:[1,2],
    storage:new Map(), schedules:new Map(), ratings:new Map(), trackRatings:new Map(), writes:[], calls:[], logs:[],
    scanning:false, clock:1000, ...options};
  h.ratingKey = (user, kind, id) => JSON.stringify([user,kind,id]);
  h.getRating = (user, kind, id) => h.ratings.get(h.ratingKey(user,kind,id)) ?? 0;
  h.setRating = (user, kind, id, value) => h.ratings.set(h.ratingKey(user,kind,id),value);
  h.envelope = value => ({responseJson:JSON.stringify({"subsonic-response":{status:"ok", type:"navidrome", openSubsonic:true, ...value}})});
  h.host = (name, request = {}) => {
    h.calls.push({name, request:structuredClone(request)});
    if (h.before) {const result=h.before(name,request); if(result !== undefined)return result;}
    let result;
    if (name === "kvstore_get") result=h.storage.has(request.key)?{exists:true,value:h.storage.get(request.key)}:{exists:false};
    else if (name === "kvstore_set") {
      if(Buffer.from(request.value,"base64").toString("base64")!==request.value)throw Error("Invalid base64 host value");
      h.storage.set(request.key,request.value); result={};
    } else if (name === "scheduler_schedulerecurring") {
      if(h.schedules.has(request.scheduleId))result={error:`schedule ID "${request.scheduleId}" already exists`};
      else {h.schedules.set(request.scheduleId,request);result={newScheduleId:request.scheduleId};}
    } else if (name === "scheduler_cancelschedule") {
      result=h.schedules.delete(request.scheduleId)?{}:{error:`schedule ID "${request.scheduleId}" not found`};
    } else if (name === "users_getusers") result={result:h.users.map(userName=>({userName}))};
    else if (name === "library_getalllibraries") result={result:h.grants.map(id=>({id,name:`Example library ${id}`}))};
    else if (name === "subsonicapi_call") {
      const url=new URL(request.uri,"http://example.invalid");
      const endpoint=url.pathname.slice(1), user=url.searchParams.get("u"), id=url.searchParams.get("id");
      if(!h.users.includes(user))return {error:"Unauthorized user"};
      const body={};
      if(endpoint==="getMusicFolders")body.musicFolders={musicFolder:h.folders.map(id=>({id,name:`Example library ${id}`}))};
      else if(endpoint==="getScanStatus")body.scanStatus={scanning:h.scanning};
      else if(endpoint==="getAlbumList2") {
        const libraryId=Number(url.searchParams.get("musicFolderId"));
        if(!h.grants.includes(libraryId)||!h.folders.includes(libraryId))throw Error("Out-of-scope library request");
        const offset=Number(url.searchParams.get("offset")), size=Math.min(h.pageCap??500,Number(url.searchParams.get("size")));
        const selected=h.albums.filter(a=>a.libraryId===libraryId).sort((a,b)=>a.id<b.id?-1:1);
        body.albumList2={album:selected.slice(offset,offset+size).map(a=>({id:a.id,name:a.name,songCount:a.songs.length}))};
      } else if(endpoint==="getAlbum") {
        const a=h.albums.find(a=>a.id===id);
        if(!a)throw Error("Album not found");
        body.album={id, name:a.name, songCount:a.songs.length, userRating:h.getRating(user,"album",id), artists:a.artists,
          song:a.songs.map(original=>{
            const song=structuredClone(original);
            song.userRating=h.trackRatings.get(JSON.stringify([user,song.id])) ?? (user==="example-unrated"?0:original.userRating);
            if(song.userRating===0)delete song.userRating; // Navidrome's actual omitempty contract.
            return song;
          })};
      } else if(endpoint==="getArtist") {
        const all=h.albums.flatMap(a=>[...a.artists,...a.songs.flatMap(s=>s.artists)]);
        const artist=all.find(a=>a.id===id);
        if(!artist)throw Error("Artist not found");
        body.artist={id,name:artist.name,albumCount:h.albums.filter(a=>a.artists.some(a=>a.id===id)).length};
        const current=h.getRating(user,"artist",id); if(current)body.artist.userRating=current;
      } else if(endpoint==="setRating") {
        let kind;
        if(h.albums.some(a=>a.id===id))kind="album";
        else if(h.albums.some(a=>a.artists.some(a=>a.id===id)||a.songs.some(s=>s.artists.some(a=>a.id===id))))kind="artist";
        else throw Error("A song or unknown ID must never be written");
        const rating=Number(url.searchParams.get("rating"));
        h.setRating(user,kind,id,rating);h.writes.push({user,kind,id,rating});
      } else throw Error(`Unexpected endpoint ${endpoint}`);
      result=h.envelope(body);
    } else throw Error(`Unexpected host function ${name}`);
    return h.after ? h.after(name,request,result) ?? result : result;
  };
  h.events = event => h.logs.map(([,line])=>JSON.parse(line.slice("Automatic Ratings: ".length)))
    .filter(e=>!event||e.event===event);
  h.state = () => decode(h.storage.get("automatic-ratings:v1:scan"));
  h.make = (config={}, extra={}) => createPlugin({host:h.host,readConfig:key=>config[key],now:()=>h.clock,
    log:(...args)=>h.logs.push(args),...extra});
  h.run = (config={}, extra={}) => {const plugin=h.make(config,extra);plugin.initialize();plugin.startRun();
    let result;let callbacks=0;
    do {result=plugin.onSchedule({payload:"worker"});if(++callbacks>1000)throw Error("Run did not finish");}
    while(result.active);return {plugin,result};};
  return h;
}
module.exports={fixture,ref};
