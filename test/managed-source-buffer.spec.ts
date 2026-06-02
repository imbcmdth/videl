import { test, expect } from '@playwright/test';

test.describe('ManagedSourceBuffer', () => {
  test.beforeEach(async ({ page }) => {
    await page.setContent(`
      <html>
        <body>
          <video id="video"></video>
        </body>
      </html>
    `);
  });

  test('should append data successfully', async ({ page }) => {
    const result = await page.evaluate(async () => {
      // Create MediaSource and SourceBuffer
      const mediaSource = new MediaSource();
      const video = document.getElementById('video') as HTMLVideoElement;
      video.src = URL.createObjectURL(mediaSource);
      
      // Wait for sourceopen
      await new Promise<void>(resolve => {
        mediaSource.addEventListener('sourceopen', () => resolve());
      });
      
      // Create SourceBuffer
      const sourceBuffer = mediaSource.addSourceBuffer('video/mp4; codecs="avc1.42E01E,mp4a.40.2"');
      
      // Import and test ManagedSourceBuffer
      const { ManagedSourceBuffer } = await import('../src/managed-source-buffer');
      const managedSourceBuffer = new ManagedSourceBuffer(sourceBuffer);
      
      // Try to append some data (this would normally be real fMP4 data)
      try {
        await managedSourceBuffer.append(new Uint8Array([0x00, 0x00, 0x00, 0x00]));
        return { success: true };
      } catch (error) {
        return { success: false, error: error.message };
      }
    });
    
    expect(result.success).toBe(true);
  });

  test('should handle concurrent operations correctly', async ({ page }) => {
    const result = await page.evaluate(async () => {
      // Create MediaSource and SourceBuffer
      const mediaSource = new MediaSource();
      const video = document.getElementById('video') as HTMLVideoElement;
      video.src = URL.createObjectURL(mediaSource);
      
      // Wait for sourceopen
      await new Promise<void>(resolve => {
        mediaSource.addEventListener('sourceopen', () => resolve());
      });
      
      // Create SourceBuffer
      const sourceBuffer = mediaSource.addSourceBuffer('video/mp4; codecs="avc1.42E01E,mp4a.40.2"');
      
      // Import and test ManagedSourceBuffer
      const { ManagedSourceBuffer } = await import('../src/managed-source-buffer');
      const managedSourceBuffer = new ManagedSourceBuffer(sourceBuffer);
      
      // Test concurrent append operations
      try {
        const append1 = managedSourceBuffer.append(new Uint8Array([0x00, 0x00, 0x00, 0x00]));
        const append2 = managedSourceBuffer.append(new Uint8Array([0x00, 0x00, 0x00, 0x00]));
        
        await Promise.all([append1, append2]);
        return { success: true };
      } catch (error) {
        return { success: false, error: error.message };
      }
    });
    
    expect(result.success).toBe(true);
  });
});