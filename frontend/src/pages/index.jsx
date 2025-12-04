import React, { useState, useEffect } from 'react';
import Head from 'next/head';
import { useSelector, useDispatch } from 'react-redux';
import axios from 'axios';
import {
  HeroBanner,
  CategoryGrid,
  ProductCarousel,
  DailyDeals,
  FlashSales,
  RecommendedForYou,
  TrendingProducts,
  Newsletter
} from '../components/home';
import Layout from '../components/layout/Layout';

export default function Home() {
  const [featuredProducts, setFeaturedProducts] = useState([]);
  const [dailyDeals, setDailyDeals] = useState([]);
  const [flashSales, setFlashSales] = useState([]);
  const [trending, setTrending] = useState([]);
  const [loading, setLoading] = useState(true);

  const dispatch = useDispatch();
  const user = useSelector((state) => state.auth.user);

  useEffect(() => {
    fetchHomeData();
  }, []);

  const fetchHomeData = async () => {
    try {
      setLoading(true);
      const [
        featuredRes,
        dealsRes,
        salesRes,
        trendingRes
      ] = await Promise.all([
        axios.get('/api/products?featured=true&limit=8'),
        axios.get('/api/deals/daily'),
        axios.get('/api/sales/flash'),
        axios.get('/api/products/trending')
      ]);

      setFeaturedProducts(featuredRes.data.products);
      setDailyDeals(dealsRes.data.deals);
      setFlashSales(salesRes.data.sales);
      setTrending(trendingRes.data.products);
    } catch (error) {
      console.error('Error fetching home data:', error);
    } finally {
      setLoading(false);
    }
  };

  return (
    <Layout>
      <Head>
        <title>Welcome to Temu Clone - Amazing Deals Every Day</title>
        <meta name="description" content="Discover amazing products at unbeatable prices. Free shipping on orders over $50." />
        <meta name="keywords" content="ecommerce, shopping, deals, discounts, temu clone" />
      </Head>

      {/* Hero Banner */}
      <HeroBanner />

      {/* Categories */}
      <section className="container mx-auto px-4 py-8">
        <h2 className="text-3xl font-bold mb-6">Shop by Category</h2>
        <CategoryGrid />
      </section>

      {/* Daily Deals */}
      <section className="bg-gray-50 py-8">
        <div className="container mx-auto px-4">
          <div className="flex justify-between items-center mb-6">
            <h2 className="text-3xl font-bold">Daily Deals</h2>
            <a href="/deals" className="text-blue-600 hover:underline">
              View All →
            </a>
          </div>
          <DailyDeals deals={dailyDeals} loading={loading} />
        </div>
      </section>

      {/* Flash Sales */}
      <section className="container mx-auto px-4 py-8">
        <div className="flex justify-between items-center mb-6">
          <div>
            <h2 className="text-3xl font-bold">Flash Sales</h2>
            <p className="text-gray-600">Limited time offers ending soon!</p>
          </div>
          <div className="flex items-center space-x-4">
            <div className="text-center">
              <div className="text-2xl font-bold text-red-600">02</div>
              <div className="text-sm text-gray-500">Hours</div>
            </div>
            <div className="text-center">
              <div className="text-2xl font-bold text-red-600">45</div>
              <div className="text-sm text-gray-500">Minutes</div>
            </div>
            <div className="text-center">
              <div className="text-2xl font-bold text-red-600">18</div>
              <div className="text-sm text-gray-500">Seconds</div>
            </div>
          </div>
        </div>
        <FlashSales sales={flashSales} loading={loading} />
      </section>

      {/* Recommended For You */}
      {user && (
        <section className="container mx-auto px-4 py-8">
          <h2 className="text-3xl font-bold mb-6">Recommended For You</h2>
          <RecommendedForYou userId={user._id} />
        </section>
      )}

      {/* Trending Products */}
      <section className="bg-gray-50 py-8">
        <div className="container mx-auto px-4">
          <div className="flex justify-between items-center mb-6">
            <h2 className="text-3xl font-bold">Trending Now</h2>
            <a href="/products/trending" className="text-blue-600 hover:underline">
              View All →
            </a>
          </div>
          <TrendingProducts products={trending} loading={loading} />
        </div>
      </section>

      {/* Featured Products */}
      <section className="container mx-auto px-4 py-8">
        <h2 className="text-3xl font-bold mb-6">Featured Products</h2>
        <ProductCarousel products={featuredProducts} />
      </section>

      {/* Newsletter */}
      <Newsletter />
    </Layout>
  );
}
