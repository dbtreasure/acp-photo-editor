#!/bin/bash

# Test script for Phase 7d export flow with auto-approve
set -e

echo "Testing Phase 7d Export Flow with Auto-Approve"
echo "==============================================="
echo ""

# Enable auto-approve for testing
export PHOTO_AGENT_AUTO_APPROVE_EXPORT=true

echo "✅ Auto-approve enabled: PHOTO_AGENT_AUTO_APPROVE_EXPORT=$PHOTO_AGENT_AUTO_APPROVE_EXPORT"
echo ""

echo "Expected trace spans for export flow:"
echo "-------------------------------------"
echo "1. ask_command (main span ~6-7s)"
echo "   └─ preview.capture (60ms with JPEG q=60)"
echo "   └─ planner.execute (~6s, will log if >3s timeout)"
echo "   └─ operations.apply (<1ms)"
echo "   └─ preview.render (~70ms)"
echo "2. export.execute (separate span)"
echo "   └─ permission.request (auto-approved)"
echo "   └─ mcp.commit_version"
echo ""

echo "New attributes to verify:"
echo "------------------------"
echo "- turn_id: increments per command"
echo "- planner.calls_list: 'wb,ev,contrast,crop,export'"
echo "- operations.dropped_list: shows dropped ops"
echo "- preview.image_width/height: actual dimensions"
echo "- preview.ops_list: comma-separated operations"
echo "- permission.auto_approved: true"
echo "- export.bytes: actual file size"
echo ""

echo "Test command to run after loading image:"
echo "----------------------------------------"
echo ':ask --with-image "neutralize the blue cast, lift shadows, make it warmer, square crop, export PNG"'
echo ""

echo "The export should now complete successfully with:"
echo "- Export auto-approved (no timeout)"
echo "- File written to Export/ directory"
echo "- Full span chain visible in Jaeger"
echo ""

echo "Check improvements:"
echo "- Planner latency: Should be closer to target (was 6.26s)"
echo "- Preview size: Reduced with JPEG q=60 (was q=80)"
echo "- Export flow: Should complete with proper telemetry"