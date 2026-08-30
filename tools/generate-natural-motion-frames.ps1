param(
  [string]$ImageDirectory = (Join-Path $PSScriptRoot '..\materials\images')
)

$ErrorActionPreference = 'Stop'
$resolvedImageDirectory = (Resolve-Path -LiteralPath $ImageDirectory).Path

Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;

public static class NaturalMotionFrameGenerator {
  const int CellSize = 20;
  const int GridWidth = 288;
  const int GridHeight = 182;
  const int Blue = unchecked((int)0xFF1F439B);
  const int White = unchecked((int)0xFFFFFFFF);

  static Point[] Polygon(params int[] coordinates) {
    if (coordinates.Length % 2 != 0) throw new ArgumentException("Polygon coordinates must be x/y pairs.");
    var points = new Point[coordinates.Length / 2];
    for (int index = 0; index < points.Length; index++) points[index] = new Point(coordinates[index * 2], coordinates[index * 2 + 1]);
    return points;
  }

  static Point[] Rectangle(int left, int top, int right, int bottom) {
    return Polygon(left, top, right, top, right, bottom, left, bottom);
  }

  static bool Contains(Point[] polygon, double x, double y) {
    bool inside = false;
    for (int index = 0, previous = polygon.Length - 1; index < polygon.Length; previous = index++) {
      double currentY = polygon[index].Y;
      double previousY = polygon[previous].Y;
      bool crosses = (currentY > y) != (previousY > y);
      if (!crosses) continue;
      double intersectionX = (polygon[previous].X - polygon[index].X) * (y - currentY) / (previousY - currentY) + polygon[index].X;
      if (x < intersectionX) inside = !inside;
    }
    return inside;
  }

  static int[,] Move(int[,] frame, Point[] polygon, int deltaX, int deltaY) {
    var before = (int[,])frame.Clone();
    var result = (int[,])frame.Clone();
    var mask = new bool[GridWidth, GridHeight];

    for (int y = 0; y < GridHeight; y++) {
      for (int x = 0; x < GridWidth; x++) mask[x, y] = Contains(polygon, x + .5, y + .5);
    }

    for (int y = 0; y < GridHeight; y++) {
      for (int x = 0; x < GridWidth; x++) {
        if (!mask[x, y]) continue;
        int coveringX = x - deltaX;
        int coveringY = y - deltaY;
        bool covered = coveringX >= 0 && coveringX < GridWidth && coveringY >= 0 && coveringY < GridHeight && mask[coveringX, coveringY];
        if (!covered) {
          int sampleX = Math.Max(0, Math.Min(GridWidth - 1, coveringX));
          int sampleY = Math.Max(0, Math.Min(GridHeight - 1, coveringY));
          result[x, y] = before[sampleX, sampleY];
        }
      }
    }

    for (int y = 0; y < GridHeight; y++) {
      for (int x = 0; x < GridWidth; x++) {
        if (!mask[x, y]) continue;
        int targetX = x + deltaX;
        int targetY = y + deltaY;
        if (targetX >= 0 && targetX < GridWidth && targetY >= 0 && targetY < GridHeight) result[targetX, targetY] = before[x, y];
      }
    }

    return result;
  }

  static void Paint(int[,] frame, int left, int top, int width, int height, int color) {
    for (int y = Math.Max(0, top); y < Math.Min(GridHeight, top + height); y++) {
      for (int x = Math.Max(0, left); x < Math.Min(GridWidth, left + width); x++) frame[x, y] = color;
    }
  }

  static int[,] LoadGrid(string path) {
    using (var bitmap = new Bitmap(path)) {
      if (bitmap.Width != GridWidth * CellSize || bitmap.Height != GridHeight * CellSize) {
        throw new InvalidOperationException(Path.GetFileName(path) + " must be 5760x3640.");
      }

      var grid = new int[GridWidth, GridHeight];
      for (int y = 0; y < GridHeight; y++) {
        for (int x = 0; x < GridWidth; x++) {
          int color = bitmap.GetPixel(x * CellSize + CellSize / 2, y * CellSize + CellSize / 2).ToArgb();
          if (color != Blue && color != White) throw new InvalidOperationException(Path.GetFileName(path) + " must use the established blue/white palette.");
          grid[x, y] = color;
        }
      }
      return grid;
    }
  }

  static int DifferenceCount(int[,] first, int[,] second) {
    int count = 0;
    for (int y = 0; y < GridHeight; y++) for (int x = 0; x < GridWidth; x++) if (first[x, y] != second[x, y]) count++;
    return count;
  }

  static void SaveFrame(string sourcePath, string targetPath, int[,] baseGrid, int[,] frameGrid) {
    string temporaryPath = Path.Combine(Path.GetTempPath(), Guid.NewGuid().ToString("N") + ".png");
    try {
      using (var bitmap = new Bitmap(sourcePath)) {
        using (var graphics = Graphics.FromImage(bitmap)) {
          graphics.CompositingMode = CompositingMode.SourceCopy;
          graphics.SmoothingMode = SmoothingMode.None;
          for (int y = 0; y < GridHeight; y++) {
            for (int x = 0; x < GridWidth; x++) {
              if (baseGrid[x, y] == frameGrid[x, y]) continue;
              using (var brush = new SolidBrush(Color.FromArgb(frameGrid[x, y]))) {
                graphics.FillRectangle(brush, x * CellSize, y * CellSize, CellSize, CellSize);
              }
            }
          }
        }
        bitmap.Save(temporaryPath, ImageFormat.Png);
      }
      File.Copy(temporaryPath, targetPath, true);
    } finally {
      if (File.Exists(temporaryPath)) File.Delete(temporaryPath);
    }
  }

  static int[,] BuildOpening(int[,] source, bool peak) {
    var frame = (int[,])source.Clone();
    frame = Move(frame, Polygon(68, 56, 82, 43, 98, 35, 106, 42, 96, 59, 88, 83, 80, 112, 69, 113), peak ? -1 : 0, -1);
    frame = Move(frame, Polygon(172, 34, 190, 39, 203, 54, 211, 82, 216, 111, 207, 113, 200, 84, 186, 57), peak ? 1 : 0, -1);
    frame = Move(frame, Rectangle(116, 63, 126, 119), 0, -1);
    return frame;
  }

  static int[,] BuildGraduation(int[,] source, bool peak) {
    var frame = (int[,])source.Clone();
    frame = Move(frame, Polygon(145, 57, 159, 45, 171, 50, 166, 76, 158, 101, 147, 107), peak ? -1 : 0, -1);
    frame = Move(frame, Polygon(178, 48, 192, 58, 204, 80, 208, 109, 199, 112, 191, 88, 184, 70), peak ? 1 : 0, -1);
    frame = Move(frame, Polygon(126, 82, 147, 76, 154, 92, 145, 110, 126, 112), peak ? -2 : -1, 0);
    frame = Move(frame, Rectangle(116, 20, 134, 46), peak ? -2 : -1, 0);
    return frame;
  }

  static int[,] BuildLivestream(int[,] source, bool peak) {
    var frame = (int[,])source.Clone();
    frame = Move(frame, Polygon(202, 70, 217, 62, 226, 76, 220, 104, 209, 124, 202, 113), peak ? -1 : 0, -1);
    frame = Move(frame, Polygon(242, 58, 258, 69, 270, 95, 275, 124, 266, 130, 257, 101, 248, 79), peak ? 1 : 0, -1);
    frame = Move(frame, Polygon(143, 65, 156, 58, 171, 70, 174, 92, 163, 100, 146, 90), peak ? -2 : -1, 0);
    return frame;
  }

  static int[,] BuildManipulated(int[,] source, bool peak) {
    var frame = (int[,])source.Clone();
    frame = Move(frame, Polygon(142, 87, 158, 73, 173, 80, 168, 110, 158, 137, 144, 132), peak ? -1 : 0, -1);
    frame = Move(frame, Polygon(186, 76, 207, 84, 226, 105, 236, 138, 226, 143, 211, 116, 197, 95), peak ? 1 : 0, -1);
    Paint(frame, peak ? 255 : 253, 43, peak ? 4 : 2, 1, White);
    return frame;
  }

  static int[,] BuildEndingOne(int[,] source, bool peak) {
    var frame = (int[,])source.Clone();
    frame = Move(frame, Polygon(218, 20, 235, 15, 251, 24, 253, 45, 237, 56, 218, 43), peak ? -2 : -1, 0);
    frame = Move(frame, Polygon(259, 16, 277, 16, 278, 116, 269, 117, 264, 82), peak ? -2 : -1, 0);
    Paint(frame, peak ? 208 : 206, 70, 2, 1, White);
    return frame;
  }

  static int[,] BuildEndingTwo(int[,] source, bool peak) {
    var frame = (int[,])source.Clone();
    frame = Move(frame, Polygon(36, 50, 52, 43, 55, 62, 45, 70, 35, 66), peak ? 2 : 1, peak ? -2 : -1);
    frame = Move(frame, Rectangle(236, 18, 266, 38), peak ? 2 : 1, 0);
    frame = Move(frame, Rectangle(75, 129, 102, 147), peak ? 2 : 1, 0);
    Paint(frame, peak ? 217 : 215, 77, 2, 1, White);
    Paint(frame, 245, peak ? 101 : 99, 2, 2, White);
    return frame;
  }

  static int[,] BuildEndingThree(int[,] source, bool peak) {
    var frame = (int[,])source.Clone();
    frame = Move(frame, Polygon(86, 71, 101, 59, 116, 65, 113, 96, 104, 125, 89, 127), peak ? -1 : 0, -1);
    frame = Move(frame, Polygon(151, 59, 169, 67, 184, 89, 191, 123, 181, 129, 169, 101, 158, 78), peak ? 1 : 0, -1);
    frame = Move(frame, Polygon(232, 105, 249, 100, 270, 113, 272, 139, 252, 147, 233, 137), peak ? -2 : -1, 0);
    frame = Move(frame, Rectangle(132, 37, 154, 53), peak ? -1 : 0, 0);
    return frame;
  }

  static int[,] BuildFrame(string key, int[,] source, bool peak) {
    switch (key) {
      case "opening": return BuildOpening(source, peak);
      case "graduation": return BuildGraduation(source, peak);
      case "livestream": return BuildLivestream(source, peak);
      case "manipulated": return BuildManipulated(source, peak);
      case "ending-one": return BuildEndingOne(source, peak);
      case "ending-two": return BuildEndingTwo(source, peak);
      case "ending-three": return BuildEndingThree(source, peak);
      default: throw new InvalidOperationException("Unknown illustration key: " + key);
    }
  }

  public static string Generate(string directory, string key, string name) {
    string sourcePath = Path.Combine(directory, name + ".PNG");
    string frameBPath = Path.Combine(directory, name + "-frame-b.PNG");
    string frameCPath = Path.Combine(directory, name + "-frame-c.PNG");
    int[,] source = LoadGrid(sourcePath);
    int[,] frameB = BuildFrame(key, source, false);
    int[,] frameC = BuildFrame(key, source, true);
    int changedB = DifferenceCount(source, frameB);
    int changedC = DifferenceCount(source, frameC);
    int progression = DifferenceCount(frameB, frameC);
    if (changedB < 80 || changedC < 100 || progression < 40) {
      throw new InvalidOperationException(name + " motion is too subtle: frame B " + changedB + ", frame C " + changedC + ", B/C " + progression + ".");
    }
    if (changedB > 6000 || changedC > 6000) throw new InvalidOperationException(name + " motion changes too much of the composition.");
    SaveFrame(sourcePath, frameBPath, source, frameB);
    SaveFrame(sourcePath, frameCPath, source, frameC);
    return name + ": frame B " + changedB + " cells, frame C " + changedC + " cells, B/C difference " + progression + " cells";
  }

  public static string[] GenerateAll(string directory) {
    string[] keys = { "opening", "graduation", "livestream", "manipulated", "ending-one", "ending-two", "ending-three" };
    string[] names = {
      "\u5F00\u5934",
      "\u6BD5\u4E1A",
      "\u76F4\u64AD",
      "\u88AB\u6362\u8138",
      "\u7ED3\u5C40\u4E00",
      "\u7ED3\u5C40\u4E8C",
      "\u7ED3\u5C40\u4E09"
    };
    string[] openingMatches = Directory.GetFiles(directory, names[0] + ".PNG", SearchOption.AllDirectories);
    if (openingMatches.Length != 1) throw new InvalidOperationException("Could not resolve the event illustration directory.");
    string resolvedDirectory = Path.GetDirectoryName(openingMatches[0]);
    var results = new List<string>();
    for (int index = 0; index < keys.Length; index++) results.Add(Generate(resolvedDirectory, keys[index], names[index]));
    return results.ToArray();
  }
}
'@

[NaturalMotionFrameGenerator]::GenerateAll($resolvedImageDirectory)
