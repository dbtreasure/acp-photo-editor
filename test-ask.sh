#!/bin/bash
# Test script for Phase 7a :ask command

echo "Testing Phase 7a - :ask command with MockPlanner"
echo "================================================"
echo ""

# Build the project
echo "Building project..."
npm run build

echo ""
echo "Starting interactive client with test commands..."
echo ""

# Create a test command file
cat > test-commands.txt << 'EOF'
:open test/assets/test.jpg
:ask "warmer, +0.5 ev, more contrast, crop square"
:ask "cool by 200, ev 10"
:ask "undo undo redo"
:exit
EOF

# Run the client with the test commands
node dist/cmd/photo-client.js \
  --agent node \
  --agentArgs "dist/cmd/photo-agent.js" \
  --cwd . \
  --planner mock \
  --interactive < test-commands.txt

echo ""
echo "Test complete!"