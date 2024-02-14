import axios from 'axios';
import { redis } from '@/lib/rediscache';
import { NextResponse } from "next/server"
import { CombineEpisodeMeta } from '@/utils/EpisodeFunctions';

axios.interceptors.request.use(config =>{
  // config.timeout = 8000;
  return config;
})

async function fetchConsumetEpisodes(id) {
  try {
    async function fetchData(dub) {
      const { data } = await axios.get(
        `  https://consumet-api-pb49.onrender.com/meta/anilist/episodes/${id}${dub ? "?dub=true" : ""}`
      );
      if (data?.message === "Anime not found" && data?.length < 1) {
        return [];
      }

      // return data.episodes;
      return data;
    }

    const [subData, dubData] = await Promise.all([
      fetchData(),
      fetchData(true),
    ]);

    const array = [
      {
        consumet:true,
        providerId: "gogoanime",
        episodes: {
          sub: subData,
          dub: dubData,
        },
      },
    ];

    return array;
  } catch (error) {
    console.error("Error fetching and processing consumet:", error.message);
    return [];
  }
}

async function fetchAnifyEpisodes(id) {
  try {
    const { data } = await axios.get(`https://api.anify.tv/info/${id}?fields=[episodes]`);

    const epdata = data.episodes.data
    if (!data) {
      return [];
    }

    const filtereddata = epdata.filter((episodes) => episodes.providerId !== "9anime");
    return filtereddata;
  } catch (error) {
    console.error("Error fetching and processing anify:", error.message);
    return [];
  }
}

async function fetchEpisodeImages(id, available = false) {
  try {
    if (available) {
      return null;
    }
    const { data } = await axios.get(
      `https://api.anify.tv/content-metadata/${id}`
    );

    if (!data) {
      return [];
    }

    const metadata = data?.find((i) => i.providerId === "tvdb") || data[0];
    return metadata?.data;

  } catch (error) {
    console.error("Error fetching and processing meta:", error.message);
    return [];
  }
}

const fetchAndCacheData = async (id, meta, redis, cacheTime) => {
  const [consumet, anify, cover] = await Promise.all([
    fetchConsumetEpisodes(id),
    fetchAnifyEpisodes(id),
    fetchEpisodeImages(id, meta)
  ]);

  if (consumet.length > 0 || anify.length > 0) {
    await redis.setex(`episode:${id}`, cacheTime, JSON.stringify([...consumet, ...anify]));
  }

  const combinedData = [...consumet, ...anify];
  let data = combinedData;

  if (meta) {
    data = await CombineEpisodeMeta(combinedData, JSON.parse(meta));
  } else if (cover && cover?.length > 0) {
    try {
      if (redis) await redis.setex(`meta:${id}`, cacheTime, JSON.stringify(cover));
      data = await CombineEpisodeMeta(combinedData, cover);
    } catch (error) {
      console.error("Error serializing cover:", error.message);
    }
  }

  return data;
};

export const GET = async (req, { params }) => {
  const url = new URL(req.url);
  const id = params.animeid[0];
  const releasing = url.searchParams.get('releasing') || false;
  const refresh = url.searchParams.get('refresh') === 'true' || false;

  let cacheTime = null;
  if (releasing === "true") {
    cacheTime = 60 * 60 * 3; 
  } else if (releasing === "false") {
    cacheTime = 60 * 60 * 24 * 45;
  }

  let meta = null;
  let cached;

  if (redis) {
    try {
      meta = await redis.get(`meta:${id}`);
      if(JSON.parse(meta)?.length === 0){
        await redis.del(`meta:${id}`);
        console.log("deleted meta cache");
        meta = null;
      }
      cached = await redis.get(`episode:${id}`);
      if (JSON.parse(cached)?.length === 0) {
        await redis.del(`episode:${id}`);
        cached = null;
      }
      let data;
      if (refresh) {
        data = await fetchAndCacheData(id, meta, redis, cacheTime);
      }
      if(data?.length > 0){
        console.log("deleted cache");
        return NextResponse.json(data);
      }

      console.log("using redis");
    } catch (error) {
      console.error("Error checking Redis cache:", error.message);
    }
  }

  if (cached) {
    try {
      let cachedData = JSON.parse(cached);
      if (meta) {
        cachedData = await CombineEpisodeMeta(cachedData, JSON.parse(meta));
      }
      return NextResponse.json(cachedData);
    } catch (error) {
      console.error("Error parsing cached data:", error.message);
    }
  } else {
    const fetchdata = await fetchAndCacheData(id, meta, redis, cacheTime);
    return NextResponse.json(fetchdata);
  }
};
