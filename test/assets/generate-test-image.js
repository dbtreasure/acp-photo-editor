#!/usr/bin/env node
// Generate a simple test image for Phase 2 testing
const sharp = require('sharp');
const path = require('path');

async function generateTestImage() {
  const width = 800;
  const height = 600;
  
  // Create a simple gradient image
  const svgImage = `
    <svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="gradient" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" style="stop-color:rgb(255,0,0);stop-opacity:1" />
          <stop offset="50%" style="stop-color:rgb(0,255,0);stop-opacity:1" />
          <stop offset="100%" style="stop-color:rgb(0,0,255);stop-opacity:1" />
        </linearGradient>
      </defs>
      <rect width="${width}" height="${height}" fill="url(#gradient)" />
      <text x="50%" y="50%" font-family="Arial" font-size="48" fill="white" text-anchor="middle" dy=".3em">TEST IMAGE</text>
    </svg>
  `;
  
  const buffer = Buffer.from(svgImage);
  
  // Generate test.jpg
  await sharp(buffer)
    .jpeg({ quality: 90 })
    .toFile(path.join(__dirname, 'test.jpg'));
  
  console.log('Generated test.jpg (800x600)');
  
  // Generate test.png
  await sharp(buffer)
    .png()
    .toFile(path.join(__dirname, 'test.png'));
  
  console.log('Generated test.png (800x600)');
  
  // Generate large.jpg (4K resolution)
  const largeSvg = svgImage.replace('800', '3840').replace('600', '2160');
  await sharp(Buffer.from(largeSvg))
    .jpeg({ quality: 85 })
    .toFile(path.join(__dirname, 'large.jpg'));
  
  console.log('Generated large.jpg (3840x2160)');
}

generateTestImage().catch(console.error);