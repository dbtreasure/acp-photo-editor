#!/bin/bash

# Test script for Phase 7c vision functionality

echo "Testing Phase 7c Vision Mode..."
echo "================================"
echo ""

# Build project
echo "Building project..."
npm run build > /dev/null 2>&1

# Start the photo client in interactive mode
echo "Starting photo client with Gemini planner..."
echo ""
echo "Test commands to try:"
echo "  1. :open test/assets/test.jpg"
echo "  2. :ask --with-image \"fix white balance\""
echo "  3. :ask --with-image \"neutralize the color cast\""
echo ""
echo "Note: Requires GEMINI_API_KEY environment variable"
echo ""

# Run the client
npm run interactive -- --planner=gemini