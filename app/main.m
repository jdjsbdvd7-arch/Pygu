#import <UIKit/UIKit.h>

#ifndef SCREEN_TITLE
#define SCREEN_TITLE @"Pygu"
#endif

@interface AppDelegate : UIResponder <UIApplicationDelegate>
@property (nonatomic, strong) UIWindow *window;
@end

@implementation AppDelegate

- (BOOL)application:(UIApplication *)application didFinishLaunchingWithOptions:(NSDictionary *)options {
  CGRect frame = UIScreen.mainScreen.bounds;
  self.window = [[UIWindow alloc] initWithFrame:frame];
  UIViewController *controller = [UIViewController new];
  controller.view.backgroundColor = [UIColor colorWithRed:0.07 green:0.08 blue:0.09 alpha:1];
  UILabel *label = [[UILabel alloc] initWithFrame:controller.view.bounds];
  label.text = SCREEN_TITLE;
  label.textColor = UIColor.whiteColor;
  label.textAlignment = NSTextAlignmentCenter;
  label.font = [UIFont systemFontOfSize:42 weight:UIFontWeightSemibold];
  label.autoresizingMask = UIViewAutoresizingFlexibleWidth | UIViewAutoresizingFlexibleHeight;
  [controller.view addSubview:label];
  self.window.rootViewController = controller;
  [self.window makeKeyAndVisible];
  return YES;
}

@end

int main(int argc, char *argv[]) {
  @autoreleasepool {
    return UIApplicationMain(argc, argv, nil, NSStringFromClass([AppDelegate class]));
  }
}
