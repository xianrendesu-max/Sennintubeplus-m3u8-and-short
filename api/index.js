import express from "express";
import { Innertube, UniversalCache } from "youtubei.js";
import { execFile } from "child_process";
import path from "path";

const app = express();
const ytdlpPath = path.resolve(process.cwd(), 'yt-dlp_linux');
const PROXY_URL = "http://ytproxy-siawaseok.duckdns.org:3007";

app.use(express.json());

// CORS設定
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Range');
  next();
});

// YouTubeクライアントの作成ヘルパー
const createYoutube = async () => {
  const options = {
    lang: "ja",
    location: "JP",
    cache: new UniversalCache(false), 
    generate_session_locally: true,
  };
  return await Innertube.create(options);
};

// -------------------------------------------------------------------
// 既存の機能群
// -------------------------------------------------------------------

app.get('/api/shortstdata', async (req, res) => {
  try {
    const youtube = await createYoutube();
    const { id } = req.query;
    if (!id) return res.status(400).json({ error: "Missing video id" });
    const info = await youtube.getInfo(id);
    res.status(200).json(info);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/suggest', async (req, res) => {
    const { q } = req.query;
    if (!q) return res.json([]);
    try {
        const url = `https://suggestqueries.google.com/complete/search?client=youtube&ds=yt&q=${encodeURIComponent(q)}`;
        const response = await fetch(url);
        const text = await response.text();
        const match = text.match(/window\.google\.ac\.h\((.*)\)/);
        if (match && match) {
            const data = JSON.parse(match);
            const suggestions = data.map(item => item);
            return res.json(suggestions);
        }
        res.json([]);
    } catch (err) {
        res.json([]);
    }
});

app.get('/api/video-proxy', async (req, res) => {
  const { url } = req.query;
  if (!url || typeof url !== 'string') return res.status(400).end();
  try {
    const headers = {};
    if (req.headers.range) headers['Range'] = req.headers.range;
    headers['User-Agent'] = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
    const response = await fetch(url, { headers });
    if (!response.ok) return res.status(response.status).end();
    const forwardHeaders = ['content-range', 'content-length', 'content-type', 'accept-ranges'];
    forwardHeaders.forEach(name => {
        const val = response.headers.get(name);
        if (val) res.setHeader(name, val);
    });
    res.status(response.status);
    if (!response.body) return res.end();
    // @ts-ignore
    const reader = response.body.getReader();
    req.on('close', () => { reader.cancel().catch(() => {}); });
    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(value);
    }
    res.end();
  } catch (err) {
    if (!res.headersSent) res.status(500).end();
  }
});

app.get('/api/video', async (req, res) => {
  try {
    const youtube = await createYoutube();
    const { id } = req.query;
    if (!id) return res.status(400).json({ error: "Missing video id" });
    const info = await youtube.getInfo(id);
    
    let allCandidates = [];
    const addCandidates = (source) => { if (Array.isArray(source)) allCandidates.push(...source); };
    addCandidates(info.watch_next_feed);
    addCandidates(info.related_videos);
    
    try {
      let currentFeed = info; 
      const seenIds = new Set();
      const relatedVideos = [];
      const MAX_VIDEOS = 40; 
      
      for (const video of allCandidates) {
         if(video.id) seenIds.add(video.id);
         relatedVideos.push(video);
      }
      
      if (relatedVideos.length < MAX_VIDEOS && typeof currentFeed.getWatchNextContinuation === 'function') {
          currentFeed = await currentFeed.getWatchNextContinuation();
          if (currentFeed && Array.isArray(currentFeed.watch_next_feed)) {
              for (const video of currentFeed.watch_next_feed) {
                  if (video.id && !seenIds.has(video.id)) {
                      seenIds.add(video.id);
                      relatedVideos.push(video);
                  }
              }
          }
      }
      info.watch_next_feed = relatedVideos;
    } catch (e) { console.warn('[API] Continuation failed', e.message); }

    if (info.secondary_info) info.secondary_info.watch_next_feed = [];
    info.related_videos = [];
    info.related = [];
    
    res.status(200).json(info);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/search', async (req, res) => {
  try {
    const youtube = await createYoutube();
    const { q: query, page = '1', sort_by } = req.query;
    if (!query) return res.status(400).json({ error: "Missing search query" });

    const targetPage = parseInt(page);
    const ITEMS_PER_PAGE = 40; 
    const filters = {};
    if (sort_by) filters.sort_by = sort_by;

    let search = await youtube.search(query, filters);
    let allVideos = [...(search.videos || [])];
    let allShorts = [...(search.shorts || [])];
    let allChannels = [...(search.channels || [])];
    let allPlaylists = [...(search.playlists || [])];

    const requiredCount = targetPage * ITEMS_PER_PAGE;
    let continuationAttempts = 0;
    const MAX_ATTEMPTS = 15; 

    while (allVideos.length < requiredCount && search.has_continuation && continuationAttempts < MAX_ATTEMPTS) {
        search = await search.getContinuation();
        if (search.videos) allVideos.push(...search.videos);
        if (search.shorts) allShorts.push(...search.shorts);
        if (search.channels) allChannels.push(...search.channels);
        if (search.playlists) allPlaylists.push(...search.playlists);
        continuationAttempts++;
    }

    const startIndex = (targetPage - 1) * ITEMS_PER_PAGE;
    const endIndex = startIndex + ITEMS_PER_PAGE;
    
    res.status(200).json({
        videos: allVideos.slice(startIndex, endIndex),
        shorts: targetPage === 1 ? allShorts : [],
        channels: targetPage === 1 ? allChannels : [],
        playlists: targetPage === 1 ? allPlaylists : [],
        nextPageToken: allVideos.length > endIndex || search.has_continuation ? String(targetPage + 1) : undefined
    });
  } catch (err) { 
      res.status(500).json({ error: err.message }); 
  }
});

app.get('/api/comments', async (req, res) => {
  try {
    const youtube = await createYoutube();
    const { id, sort_by, continuation } = req.query;
    
    if (continuation) {
        try {
             const actions = youtube.actions;
             const response = await actions.execute('/comment/get_comments', { continuation });
             
             const items = (response.data && response.data.onResponseReceivedEndpoints && response.data.onResponseReceivedEndpoints && response.data.onResponseReceivedEndpoints.appendContinuationItemsAction && response.data.onResponseReceivedEndpoints.appendContinuationItemsAction.continuationItems) 
                        || (response.data && response.data.onResponseReceivedEndpoints && response.data.onResponseReceivedEndpoints && response.data.onResponseReceivedEndpoints.reloadContinuationItemsCommand && response.data.onResponseReceivedEndpoints.reloadContinuationItemsCommand.continuationItems);
             
             if (!items) return res.json({ comments: [], continuation: null });
             
             const parsedComments = items.map(item => {
                 const c = (item.commentThreadRenderer && item.commentThreadRenderer.comment && item.commentThreadRenderer.comment.commentRenderer) || item.commentRenderer;
                 if (!c) return null;
                 return {
                    text: (c.contentText && c.contentText.runs && c.contentText.runs.map(r => r.text).join('')) || (c.content && c.content.text) || '',
                    comment_id: c.commentId,
                    published_time: (c.publishedTimeText && c.publishedTimeText.runs && c.publishedTimeText.runs && c.publishedTimeText.runs.text) || '',
                    author: { 
                        id: (c.authorEndpoint && c.authorEndpoint.browseEndpoint && c.authorEndpoint.browseEndpoint.browseId), 
                        name: (c.authorText && c.authorText.simpleText) || (c.authorText && c.authorText.runs && c.authorText.runs && c.authorText.runs.text), 
                        thumbnails: (c.authorThumbnail && c.authorThumbnail.thumbnails) || [] 
                    },
                    like_count: (c.voteCount && c.voteCount.simpleText) || '0',
                    reply_count: c.replyCount || '0',
                    is_pinned: !!c.pinnedCommentBadge
                 };
             }).filter(c => c);
             
             const nextContinuation = (items[items.length - 1] && items[items.length - 1].continuationItemRenderer && items[items.length - 1].continuationItemRenderer.continuationEndpoint && items[items.length - 1].continuationItemRenderer.continuationEndpoint.continuationCommand && items[items.length - 1].continuationItemRenderer.continuationEndpoint.continuationCommand.token);
             
             return res.json({
                 comments: parsedComments,
                 continuation: nextContinuation
             });

        } catch (e) {
            return res.status(500).json({ error: "Continuation failed: " + e.message });
        }

    } else {
        if (!id) return res.status(400).json({ error: "Missing video id" });
        const sortType = sort_by === 'newest' ? 'NEWEST_FIRST' : 'TOP_COMMENTS';
        const commentsSection = await youtube.getComments(id, sortType);
        
        const allComments = commentsSection.contents || [];
        const continuationToken = commentsSection.continuation_token;

        res.status(200).json({
          comments: allComments.map(c => ({
            text: (c.comment && c.comment.content && c.comment.content.text) || null,
            comment_id: (c.comment && c.comment.comment_id) || null,
            published_time: (c.comment && c.comment.published_time && c.comment.published_time.text) || (c.comment && c.comment.published_time) || null,
            author: { 
                id: (c.comment && c.comment.author && c.comment.author.id) || null, 
                name: (c.comment && c.comment.author && c.comment.author.name && c.comment.author.name.text) || (c.comment && c.comment.author && c.comment.author.name) || null, 
                thumbnails: (c.comment && c.comment.author && c.comment.author.thumbnails) || [] 
            },
            like_count: (c.comment && c.comment.like_count && c.comment.like_count.toString()) || '0',
            reply_count: (c.comment && c.comment.reply_count && c.comment.reply_count.toString()) || '0',
            is_pinned: (c.comment && c.comment.is_pinned) || false
          })),
          continuation: continuationToken
        });
    }
  } catch (err) { 
    res.status(500).json({ error: err.message }); 
  }
});

app.get('/api/stream', async (req, res) => {
  const { id } = req.query;
  if (!id) {
    return res.status(400).json({ error: 'Missing video id' });
  }

  const youtubeUrl = `https://www.youtube.com/watch?v=${id}`;
  const args = ['--proxy', PROXY_URL, '--dump-json', youtubeUrl];

  execFile(ytdlpPath, args, (error, stdout, stderr) => {
    if (error) {
      console.error('yt-dlp error:', stderr);
      return res.status(500).json({
        error: 'yt-dlp failed',
        details: stderr
      });
    }

    try {
      const info = JSON.parse(stdout);
      const combinedFormats = info.formats
        .filter(f => f.vcodec !== 'none' && f.acodec !== 'none' && f.ext === 'mp4' && (f.protocol === 'https' || f.protocol === 'http'))
        .sort((a, b) => (b.height || 0) - (a.height || 0));

      const streamingFormat = combinedFormats || null;

      const audioFormats = info.formats
        .filter(f => f.vcodec === 'none' && f.acodec !== 'none' && (f.protocol === 'https' || f.protocol === 'http'))
        .sort((a, b) => (b.abr || 0) - (a.abr || 0));

      const bestAudio = audioFormats.find(f => f.ext === 'm4a') || audioFormats || null;

      res.json({
        title: info.title,
        duration: info.duration,
        streamingUrl: (streamingFormat && streamingFormat.url) || null,
        audioUrl: (bestAudio && bestAudio.url) || null,
        formats: combinedFormats.map(f => ({
          quality: f.format_note || (f.height + "p"),
          height: f.height,
          container: f.ext,
          url: f.url
        }))
      });
    } catch (e) {
      console.error('JSON parse error:', e);
      res.status(500).json({ error: 'Failed to parse yt-dlp output' });
    }
  });
});

const applyChannelFilter = async (feed, sort) => {
    if (!sort || sort === 'latest') return feed;
    const filters = ['Popular', '人気順', 'Most popular'];
    let targetFilters = [];
    if (sort === 'popular') targetFilters = ['Popular', '人気順', 'Most popular'];
    if (sort === 'oldest') targetFilters = ['Oldest', '古い順'];

    for (const f of targetFilters) {
        try {
            const newFeed = await feed.applyFilter(f);
            if (newFeed) return newFeed;
        } catch (e) {}
    }
    return feed;
};

app.get('/api/channel', async (req, res) => {
  try {
    const youtube = await createYoutube();
    const { id, page = '1', sort } = req.query; 
    if (!id) return res.status(400).json({ error: "Missing channel id" });

    const channel = await youtube.getChannel(id);
    let videosFeed = await channel.getVideos();
    videosFeed = await applyChannelFilter(videosFeed, sort);

    let videosToReturn = videosFeed.videos || [];
    const targetPage = parseInt(page);
    
    if (targetPage > 1) {
        for (let i = 1; i < targetPage; i++) {
            if (videosFeed.has_continuation) {
                videosFeed = await videosFeed.getContinuation();
                videosToReturn = videosFeed.videos || [];
            } else {
                videosToReturn = [];
                break;
            }
        }
    }
    
    const title = (channel.metadata && channel.metadata.title) || (channel.header && channel.header.title && channel.header.title.text) || (channel.header && channel.header.author && channel.header.author.name) || null;
    let avatar = (channel.metadata && channel.metadata.avatar) || (channel.header && channel.header.avatar) || (channel.header && channel.header.author && channel.header.author.thumbnails) || null;
    if (Array.isArray(avatar) && avatar.length > 0) avatar = avatar.url;
    else if (typeof avatar === 'object' && avatar && avatar.url) avatar = avatar.url;

    let banner = (channel.metadata && channel.metadata.banner) || (channel.header && channel.header.banner) || null;
    if (Array.isArray(banner) && banner.length > 0) banner = banner.url;
    else if (typeof banner === 'object' && banner && banner.url) banner = banner.url;
    else if (typeof banner !== 'string') banner = null; 

    res.status(200).json({
      channel: {
        id: channel.id, 
        name: title, 
        description: (channel.metadata && channel.metadata.description) || null,
        avatar: avatar, 
        banner: banner,
        subscriberCount: (channel.metadata && channel.metadata.subscriber_count && channel.metadata.subscriber_count.pretty) || '非公開', 
        videoCount: (channel.metadata && channel.metadata.videos_count && channel.metadata.videos_count.text) || (channel.metadata && channel.metadata.videos_count) || '0'
      },
      page: targetPage, 
      videos: videosToReturn,
      nextPageToken: videosFeed.has_continuation ? String(targetPage + 1) : undefined
    });
  } catch (err) { 
      res.status(500).json({ error: err.message }); 
  }
});

app.get('/api/channel-shorts', async (req, res) => {
  try {
    const youtube = await createYoutube();
    const { id } = req.query;
    if (!id) return res.status(400).json({ error: "Missing channel id" });
    const channel = await youtube.getChannel(id);
    const shortsFeed = await channel.getShorts();
    let shorts = [];
    if (shortsFeed.videos) {
        shorts = shortsFeed.videos;
    } else if (shortsFeed.contents && Array.isArray(shortsFeed.contents)) {
        const tabContent = shortsFeed.contents;
        if (tabContent && tabContent.contents) shorts = tabContent.contents;
    }
    res.status(200).json(shorts);
  } catch (err) { 
      res.status(500).json({ error: err.message }); 
  }
});

app.get('/api/channel-live', async (req, res) => {
  try {
    const youtube = await createYoutube();
    const { id } = req.query;
    if (!id) return res.status(400).json({ error: "Missing channel id" });
    const channel = await youtube.getChannel(id);
    const liveFeed = await channel.getLiveStreams();
    res.status(200).json({ videos: liveFeed.videos || [] });
  } catch (err) {
      res.status(200).json({ videos: [] });
  }
});

app.get('/api/channel-community', async (req, res) => {
  try {
    const youtube = await createYoutube();
    const { id } = req.query;
    if (!id) return res.status(400).json({ error: "Missing channel id" });
    const channel = await youtube.getChannel(id);
    const community = await channel.getCommunity();
    const posts = (community.posts && community.posts.map(post => ({
        id: post.id,
        text: (post.content && post.content.text) || "",
        publishedTime: post.published.text,
        likeCount: (post.vote_count && post.vote_count.text) || "0",
        author: { name: post.author.name, avatar: post.author.thumbnails && post.author.thumbnails.url },
        attachment: post.attachment ? {
            type: post.attachment.type,
            images: post.attachment.images && post.attachment.images.map(i => i.url),
            choices: post.attachment.choices && post.attachment.choices.map(c => c.text.text),
            videoId: post.attachment.video && post.attachment.video.id
        } : null
    }))) || [];
    res.status(200).json({ posts });
  } catch (err) {
      res.status(200).json({ posts: [] });
  }
});

app.get('/api/channel-playlists', async (req, res) => {
  try {
    const youtube = await createYoutube();
    const { id } = req.query;
    if (!id) return res.status(400).json({ error: "Missing channel id" });
    const channel = await youtube.getChannel(id);
    const playlistsFeed = await channel.getPlaylists();
    let playlists = playlistsFeed.playlists || playlistsFeed.items || [];
    if (playlists.length === 0 && playlistsFeed.contents && Array.isArray(playlistsFeed.contents)) {
        const tabContent = playlistsFeed.contents;
        if (tabContent && tabContent.contents) playlists = tabContent.contents;
    }
    res.status(200).json({ playlists });
  } catch (err) { 
      res.status(500).json({ error: err.message }); 
  }
});

app.get('/api/playlist', async (req, res) => {
  try {
    const youtube = await createYoutube();
    const { id } = req.query;
    const playlist = await youtube.getPlaylist(id);
    if (!(playlist.info && playlist.info.id)) return res.status(404).json({ error: "Playlist not found"});
    res.status(200).json(playlist);
  } catch (err) { 
      res.status(500).json({ error: err.message }); 
  }
});

app.get('/api/fvideo', async (req, res) => {
  try {
    const youtube = await createYoutube();
    const homeFeed = await youtube.getHomeFeed();
    res.status(200).json({ videos: homeFeed.videos || homeFeed.items || [] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// -------------------------------------------------------------------
// 🌟 ここから下が今回追加した youtubei.js の新機能群 🌟
// -------------------------------------------------------------------

// 1. 急上昇（トレンド）の取得
app.get('/api/trending', async (req, res) => {
  try {
    const youtube = await createYoutube();
    const trending = await youtube.getTrending();
    res.status(200).json({
      videos: trending.videos || [],
      categories: trending.categories || []
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 2. 探索・ガイド（Explore）の取得
app.get('/api/explore', async (req, res) => {
  try {
    const youtube = await createYoutube();
    const explore = await youtube.getExplore();
    res.status(200).json(explore);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 3. ハッシュタグ検索（例: /api/hashtag?tag=マイクラ）
app.get('/api/hashtag', async (req, res) => {
  try {
    const youtube = await createYoutube();
    const { tag } = req.query;
    if (!tag) return res.status(400).json({ error: "Missing tag query" });
    
    const hashtagFeed = await youtube.getHashtag(tag);
    res.status(200).json({
      header: hashtagFeed.header,
      videos: hashtagFeed.videos || []
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 4. 動画の字幕（文字起こし）取得
app.get('/api/transcript', async (req, res) => {
  try {
    const youtube = await createYoutube();
    const { id } = req.query;
    if (!id) return res.status(400).json({ error: "Missing video id" });

    const info = await youtube.getInfo(id);
    const transcriptInfo = await info.getTranscript();
    
    const segments = (transcriptInfo && transcriptInfo.transcript && transcriptInfo.transcript.content && transcriptInfo.transcript.content.body && transcriptInfo.transcript.content.body.initial_segments && transcriptInfo.transcript.content.body.initial_segments.map(seg => ({
      text: seg.snippet && seg.snippet.text,
      startTime: seg.start_ms,
      endTime: seg.end_ms
    }))) || [];

    res.status(200).json({ segments });
  } catch (err) {
    res.status(500).json({ error: "Transcript not available or " + err.message });
  }
});

// 5. URLの解決 (URLから動画IDやチャンネルIDなどを特定)
app.get('/api/resolve', async (req, res) => {
  try {
    const youtube = await createYoutube();
    const { url } = req.query;
    if (!url) return res.status(400).json({ error: "Missing url" });

    const result = await youtube.resolveURL(url);
    res.status(200).json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- YouTube Music 機能群 (非常に安定しています) ---

// 6. Music 検索
app.get('/api/music/search', async (req, res) => {
  try {
    const youtube = await createYoutube();
    const { q, filter } = req.query; 
    if (!q) return res.status(400).json({ error: "Missing query" });

    const searchResult = await youtube.music.search(q, { type: filter });
    res.status(200).json(searchResult);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 7. Music 楽曲の詳細（ストリーミング情報など）
app.get('/api/music/track', async (req, res) => {
  try {
    const youtube = await createYoutube();
    const { id } = req.query;
    if (!id) return res.status(400).json({ error: "Missing track id" });

    const trackInfo = await youtube.music.getInfo(id);
    res.status(200).json(trackInfo);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 8. Music 歌詞の取得
app.get('/api/music/lyrics', async (req, res) => {
  try {
    const youtube = await createYoutube();
    const { id } = req.query;
    if (!id) return res.status(400).json({ error: "Missing track id" });

    const lyrics = await youtube.music.getLyrics(id);
    res.status(200).json({
       text: (lyrics && lyrics.text) || "No lyrics available",
       footer: (lyrics && lyrics.footer)
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 9. Music アーティスト情報の取得
app.get('/api/music/artist', async (req, res) => {
  try {
    const youtube = await createYoutube();
    const { id } = req.query;
    if (!id) return res.status(400).json({ error: "Missing artist id" });

    const artist = await youtube.music.getArtist(id);
    res.status(200).json(artist);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 10. Music プレイリスト・アルバムの取得
app.get('/api/music/playlist', async (req, res) => {
  try {
    const youtube = await createYoutube();
    const { id } = req.query;
    if (!id) return res.status(400).json({ error: "Missing playlist/album id" });

    const playlist = await youtube.music.getPlaylist(id);
    res.status(200).json(playlist);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 11. Music 「次に再生（Up Next / ラジオ）」の取得
app.get('/api/music/upnext', async (req, res) => {
  try {
    const youtube = await createYoutube();
    const { id } = req.query;
    if (!id) return res.status(400).json({ error: "Missing track id" });

    const upNext = await youtube.music.getUpNext(id);
    res.status(200).json(upNext);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default app;
